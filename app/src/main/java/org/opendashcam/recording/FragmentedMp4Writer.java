package org.opendashcam.recording;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Writes fragmented MP4 (ISO BMFF with moof/mdat fragments). The header goes first and every fragment is
 * complete on its own, so if recording stops abruptly (crash, phone dies) everything up to the last
 * fragment, about a second ago, still plays. A clean close adds a seek index (mfra) and the duration.
 *
 * Video: H.264 or H.265, given as Annex-B samples (start codes, as MediaCodec produces) and Annex-B
 * parameter sets. Audio: AAC with its AudioSpecificConfig.
 */
public final class FragmentedMp4Writer implements Closeable {

    private static final int VIDEO_TIMESCALE = 90_000;

    private static final class Sample {
        final byte[] data;
        final long ptsUs;
        final boolean key;
        Sample(byte[] data, long ptsUs, boolean key) { this.data = data; this.ptsUs = ptsUs; this.key = key; }
    }

    private static final class Track {
        int id;
        boolean video;
        boolean hevc;
        int width, height, rotation;
        List<byte[]> paramSets;
        int sampleRate, channels;
        byte[] asc;
        int timescale;
        final List<Sample> pending = new ArrayList<>();
        long firstPtsUs = -1;
        long decodeTime;          // in timescale units: end of the last written sample
        long lastDurationTs = 0;
        final List<long[]> fragmentIndex = new ArrayList<>(); // {time, moofOffset}
    }

    private final RandomAccessFile file;
    private final List<Track> tracks = new ArrayList<>();
    private boolean started;
    private boolean closed;
    private int sequence = 0;
    private long mehdOffset = -1;
    private long maxEndUs = 0;

    public FragmentedMp4Writer(File out) throws IOException {
        file = new RandomAccessFile(out, "rw");
        file.setLength(0);
    }

    public int addVideoTrack(boolean hevc, int width, int height, int rotation, List<byte[]> annexBParameterSets) {
        Track t = new Track();
        t.video = true;
        t.hevc = hevc;
        t.width = width;
        t.height = height;
        t.rotation = ((rotation % 360) + 360) % 360;
        t.paramSets = new ArrayList<>();
        for (byte[] ps : annexBParameterSets) t.paramSets.addAll(splitAnnexB(ps));
        t.timescale = VIDEO_TIMESCALE;
        return add(t);
    }

    public int addAudioTrack(int sampleRate, int channels, byte[] audioSpecificConfig) {
        Track t = new Track();
        t.sampleRate = sampleRate;
        t.channels = channels;
        t.asc = audioSpecificConfig;
        t.timescale = sampleRate;
        return add(t);
    }

    private int add(Track t) {
        if (started) throw new IllegalStateException("tracks must be added before start()");
        t.id = tracks.size() + 1;
        tracks.add(t);
        return tracks.size() - 1;
    }

    /** Writes the header. Call after adding all tracks. */
    public synchronized void start() throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        box(out, "ftyp", b -> {
            b.write(ascii("isom"));
            b.write(u32(0x200));
            for (String brand : new String[] {"isom", "iso6", "mp41", "avc1"}) b.write(ascii(brand));
        });
        long moovStart = out.size();
        final long[] mehdPos = {-1};
        byte[] moov = boxBytes("moov", b -> {
            b.write(fullBoxBytes("mvhd", 0, 0, m -> {
                m.write(u32(0)); m.write(u32(0));        // creation/modification time
                m.write(u32(1000)); m.write(u32(0));     // timescale, duration (in mehd)
                m.write(u32(0x00010000)); m.write(u16(0x0100)); m.write(new byte[10]);
                m.write(matrix(0));
                m.write(new byte[24]);
                m.write(u32(tracks.size() + 1));
            }));
            for (Track t : tracks) b.write(trak(t));
            b.write(boxBytes("mvex", x -> {
                mehdPos[0] = x.size(); // offset inside mvex payload
                x.write(fullBoxBytes("mehd", 1, 0, m -> m.write(u64(0))));
                for (Track t : tracks) {
                    x.write(fullBoxBytes("trex", 0, 0, m -> {
                        m.write(u32(t.id)); m.write(u32(1)); m.write(u32(0)); m.write(u32(0)); m.write(u32(0));
                    }));
                }
            }));
        });
        // Locate mehd's 64-bit duration inside the moov bytes so close() can patch it.
        int idx = indexOf(moov, ascii("mehd"));
        mehdOffset = moovStart + idx + 4 /* type */ + 4 /* version+flags */;
        out.write(moov);
        file.write(out.toByteArray());
        started = true;
    }

    /** Adds one encoded sample (a whole frame or audio packet). Video data is Annex-B. */
    public synchronized void writeSample(int track, ByteBuffer data, int size, long ptsUs, boolean keyFrame) {
        if (!started || closed) return;
        Track t = tracks.get(track);
        byte[] bytes = new byte[size];
        data.get(bytes, 0, size);
        if (t.video) bytes = toLengthPrefixed(bytes, t.hevc);
        if (bytes.length == 0) return;
        if (t.firstPtsUs < 0) t.firstPtsUs = ptsUs;
        // Timestamps must increase; clamp anything out of order.
        if (!t.pending.isEmpty() && ptsUs <= t.pending.get(t.pending.size() - 1).ptsUs) {
            ptsUs = t.pending.get(t.pending.size() - 1).ptsUs + 1;
        }
        t.pending.add(new Sample(bytes, ptsUs, !t.video || keyFrame));
    }

    /** True once the video track has a keyframe waiting, i.e. a good place to start a fragment. */
    public synchronized boolean pendingVideoKeyFrameAfterFirst() {
        for (Track t : tracks) {
            if (!t.video) continue;
            for (int i = 1; i < t.pending.size(); i++) if (t.pending.get(i).key) return true;
        }
        return false;
    }

    /**
     * Writes pending samples as one fragment. Each track keeps its newest sample back (its duration
     * isn't known yet) unless [last] is set.
     */
    public synchronized void flushFragment(boolean last) throws IOException {
        if (!started || closed) return;
        List<Track> with = new ArrayList<>();
        List<List<Sample>> batches = new ArrayList<>();
        List<long[]> durations = new ArrayList<>();
        for (Track t : tracks) {
            int n = last ? t.pending.size() : t.pending.size() - 1;
            if (n <= 0) continue;
            List<Sample> batch = new ArrayList<>(t.pending.subList(0, n));
            long[] dur = new long[n];
            for (int i = 0; i < n; i++) {
                long nextUs = (i + 1 < t.pending.size()) ? t.pending.get(i + 1).ptsUs : -1;
                long d = nextUs >= 0 ? usToTs(nextUs - batch.get(i).ptsUs, t.timescale)
                    : (t.lastDurationTs > 0 ? t.lastDurationTs : defaultDuration(t));
                dur[i] = Math.max(1, d);
                t.lastDurationTs = dur[i];
            }
            with.add(t);
            batches.add(batch);
            durations.add(dur);
        }
        if (with.isEmpty()) return;

        sequence++;
        long moofOffset = file.length();
        // Build moof with placeholder data offsets, then fix them once the moof size is known.
        int[] dataOffsetPos = new int[with.size()];
        ByteArrayOutputStream moof = new ByteArrayOutputStream();
        ByteArrayOutputStream mdatPayload = new ByteArrayOutputStream();
        long[] trackDataStart = new long[with.size()];
        for (int i = 0; i < with.size(); i++) {
            trackDataStart[i] = mdatPayload.size();
            for (Sample s : batches.get(i)) mdatPayload.write(s.data);
        }
        moof.write(u32(0)); moof.write(ascii("moof"));
        moof.write(fullBoxBytes("mfhd", 0, 0, m -> m.write(u32(sequence))));
        for (int i = 0; i < with.size(); i++) {
            Track t = with.get(i);
            List<Sample> batch = batches.get(i);
            long[] dur = durations.get(i);
            ByteArrayOutputStream traf = new ByteArrayOutputStream();
            traf.write(u32(0)); traf.write(ascii("traf"));
            traf.write(fullBoxBytes("tfhd", 0, 0x020000, m -> m.write(u32(t.id)))); // default-base-is-moof
            final long base = t.decodeTime;
            traf.write(fullBoxBytes("tfdt", 1, 0, m -> m.write(u64(base))));
            int trunStartInTraf = traf.size();
            traf.write(fullBoxBytes("trun", 0, 0x000001 | 0x000100 | 0x000200 | 0x000400, m -> {
                m.write(u32(batch.size()));
                m.write(u32(0)); // data offset, patched below
                for (int k = 0; k < batch.size(); k++) {
                    Sample s = batch.get(k);
                    m.write(u32((int) dur[k]));
                    m.write(u32(s.data.length));
                    m.write(u32(s.key ? 0x02000000 : 0x01010000));
                }
            }));
            byte[] trafBytes = traf.toByteArray();
            putU32(trafBytes, 0, trafBytes.length);
            dataOffsetPos[i] = moof.size() + trunStartInTraf + 8 + 4 + 4; // trun header + version/flags + sample_count
            moof.write(trafBytes);
            t.fragmentIndex.add(new long[] {t.decodeTime, moofOffset});
            for (long d : dur) t.decodeTime += d;
            long endUs = t.firstPtsUs + tsToUs(t.decodeTime, t.timescale);
            maxEndUs = Math.max(maxEndUs, endUs - t.firstPtsUs);
            t.pending.subList(0, batch.size()).clear();
        }
        byte[] moofBytes = moof.toByteArray();
        putU32(moofBytes, 0, moofBytes.length);
        for (int i = 0; i < with.size(); i++) {
            putU32(moofBytes, dataOffsetPos[i], (int) (moofBytes.length + 8 + trackDataStart[i]));
        }
        ByteArrayOutputStream frag = new ByteArrayOutputStream();
        frag.write(moofBytes);
        frag.write(u32(8 + mdatPayload.size()));
        frag.write(ascii("mdat"));
        mdatPayload.writeTo(frag);
        file.seek(moofOffset);
        file.write(frag.toByteArray());
    }

    /** Writes the remaining samples, a seek index and the total duration. */
    @Override
    public synchronized void close() throws IOException {
        if (closed) return;
        try {
            if (started) {
                flushFragment(true);
                writeMfra();
                file.seek(mehdOffset);
                file.write(u64(maxEndUs / 1000)); // movie timescale is 1000
            }
            file.getFD().sync();
        } finally {
            closed = true;
            file.close();
        }
    }

    public synchronized long durationUs() { return maxEndUs; }

    // ---------------------------------------------------------------- boxes

    private byte[] trak(Track t) throws IOException {
        return boxBytes("trak", b -> {
            b.write(fullBoxBytes("tkhd", 0, 0x3, m -> {
                m.write(u32(0)); m.write(u32(0)); m.write(u32(t.id)); m.write(u32(0)); m.write(u32(0));
                m.write(new byte[8]); m.write(u16(0)); m.write(u16(0));
                m.write(u16(t.video ? 0 : 0x0100)); m.write(u16(0));
                m.write(matrix(t.video ? t.rotation : 0));
                m.write(u32(t.video ? t.width << 16 : 0)); m.write(u32(t.video ? t.height << 16 : 0));
            }));
            b.write(boxBytes("mdia", md -> {
                md.write(fullBoxBytes("mdhd", 0, 0, m -> {
                    m.write(u32(0)); m.write(u32(0)); m.write(u32(t.timescale)); m.write(u32(0));
                    m.write(u16(0x55C4)); m.write(u16(0)); // language "und"
                }));
                md.write(fullBoxBytes("hdlr", 0, 0, m -> {
                    m.write(u32(0)); m.write(ascii(t.video ? "vide" : "soun")); m.write(new byte[12]);
                    m.write((t.video ? "VideoHandler" : "SoundHandler").getBytes(StandardCharsets.US_ASCII)); m.write(0);
                }));
                md.write(boxBytes("minf", mi -> {
                    if (t.video) mi.write(fullBoxBytes("vmhd", 0, 1, m -> m.write(new byte[8])));
                    else mi.write(fullBoxBytes("smhd", 0, 0, m -> m.write(new byte[4])));
                    mi.write(boxBytes("dinf", di -> di.write(fullBoxBytes("dref", 0, 0, m -> {
                        m.write(u32(1));
                        m.write(fullBoxBytes("url ", 0, 1, u -> { }));
                    }))));
                    mi.write(boxBytes("stbl", st -> {
                        st.write(fullBoxBytes("stsd", 0, 0, m -> {
                            m.write(u32(1));
                            m.write(t.video ? videoEntry(t) : audioEntry(t));
                        }));
                        st.write(fullBoxBytes("stts", 0, 0, m -> m.write(u32(0))));
                        st.write(fullBoxBytes("stsc", 0, 0, m -> m.write(u32(0))));
                        st.write(fullBoxBytes("stsz", 0, 0, m -> { m.write(u32(0)); m.write(u32(0)); }));
                        st.write(fullBoxBytes("stco", 0, 0, m -> m.write(u32(0))));
                    }));
                }));
            }));
        });
    }

    private byte[] videoEntry(Track t) throws IOException {
        return boxBytes(t.hevc ? "hvc1" : "avc1", e -> {
            e.write(new byte[6]); e.write(u16(1));
            e.write(new byte[16]);
            e.write(u16(t.width)); e.write(u16(t.height));
            e.write(u32(0x00480000)); e.write(u32(0x00480000));
            e.write(u32(0)); e.write(u16(1));
            byte[] name = new byte[32];
            byte[] label = "Open Dash Cam".getBytes(StandardCharsets.US_ASCII);
            name[0] = (byte) label.length;
            System.arraycopy(label, 0, name, 1, label.length);
            e.write(name);
            e.write(u16(0x0018)); e.write(u16(0xFFFF));
            e.write(t.hevc ? boxBytes("hvcC", c -> c.write(hvcC(t.paramSets))) : boxBytes("avcC", c -> c.write(avcC(t.paramSets))));
        });
    }

    private byte[] audioEntry(Track t) throws IOException {
        return boxBytes("mp4a", e -> {
            e.write(new byte[6]); e.write(u16(1));
            e.write(new byte[8]);
            e.write(u16(t.channels)); e.write(u16(16)); e.write(u16(0)); e.write(u16(0));
            e.write(u32(t.sampleRate << 16));
            e.write(fullBoxBytes("esds", 0, 0, m -> {
                ByteArrayOutputStream dsi = new ByteArrayOutputStream();
                dsi.write(0x05); dsi.write(t.asc.length); dsi.write(t.asc);
                ByteArrayOutputStream dcd = new ByteArrayOutputStream();
                dcd.write(0x40); dcd.write(0x15); dcd.write(new byte[] {0, 0x18, 0});
                dcd.write(u32(256000)); dcd.write(u32(128000));
                dsi.writeTo(dcd);
                ByteArrayOutputStream es = new ByteArrayOutputStream();
                es.write(u16(0)); es.write(0);
                es.write(0x04); es.write(dcd.size()); dcd.writeTo(es);
                es.write(new byte[] {0x06, 0x01, 0x02});
                m.write(0x03); m.write(es.size()); es.writeTo(m);
            }));
        });
    }

    private static byte[] avcC(List<byte[]> ps) throws IOException {
        List<byte[]> sps = new ArrayList<>(), pps = new ArrayList<>();
        for (byte[] n : ps) {
            int type = n[0] & 0x1F;
            if (type == 7) sps.add(n); else if (type == 8) pps.add(n);
        }
        if (sps.isEmpty() || pps.isEmpty()) throw new IOException("missing H.264 SPS/PPS");
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        byte[] s = sps.get(0);
        o.write(1); o.write(s[1]); o.write(s[2]); o.write(s[3]);
        o.write(0xFF);
        o.write(0xE0 | sps.size());
        for (byte[] x : sps) { o.write(u16(x.length)); o.write(x); }
        o.write(pps.size());
        for (byte[] x : pps) { o.write(u16(x.length)); o.write(x); }
        return o.toByteArray();
    }

    private static byte[] hvcC(List<byte[]> ps) throws IOException {
        List<byte[]> vps = new ArrayList<>(), sps = new ArrayList<>(), pps = new ArrayList<>();
        for (byte[] n : ps) {
            int type = (n[0] >> 1) & 0x3F;
            if (type == 32) vps.add(n); else if (type == 33) sps.add(n); else if (type == 34) pps.add(n);
        }
        if (vps.isEmpty() || sps.isEmpty() || pps.isEmpty()) throw new IOException("missing H.265 VPS/SPS/PPS");
        byte[] rbsp = unescape(sps.get(0));
        // rbsp: 2-byte NAL header, then vps_id(4) max_sub_layers_minus1(3) temporal_id_nesting(1), then 12-byte profile_tier_level
        int maxSubLayersMinus1 = (rbsp[2] >> 1) & 0x7;
        int nesting = rbsp[2] & 0x1;
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(1);
        o.write(rbsp, 3, 12); // general profile space/tier/idc, compatibility flags, constraint flags, level
        o.write(u16(0xF000));
        o.write(0xFC);
        o.write(0xFD); // 4:2:0
        o.write(0xF8);
        o.write(0xF8);
        o.write(u16(0));
        o.write(((maxSubLayersMinus1 + 1) << 3) | (nesting << 2) | 3);
        o.write(3);
        for (Object[] arr : new Object[][] {{32, vps}, {33, sps}, {34, pps}}) {
            @SuppressWarnings("unchecked") List<byte[]> list = (List<byte[]>) arr[1];
            o.write(0x80 | (Integer) arr[0]);
            o.write(u16(list.size()));
            for (byte[] x : list) { o.write(u16(x.length)); o.write(x); }
        }
        return o.toByteArray();
    }

    private void writeMfra() throws IOException {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        for (Track t : tracks) {
            if (t.fragmentIndex.isEmpty()) continue;
            body.write(fullBoxBytes("tfra", 1, 0, m -> {
                m.write(u32(t.id));
                m.write(u32(0)); // 1-byte traf/trun/sample numbers
                m.write(u32(t.fragmentIndex.size()));
                for (long[] e : t.fragmentIndex) {
                    m.write(u64(e[0])); m.write(u64(e[1])); m.write(1); m.write(1); m.write(1);
                }
            }));
        }
        byte[] mfro = fullBoxBytes("mfro", 0, 0, m -> m.write(u32(0)));
        int size = 8 + body.size() + mfro.length;
        putU32(mfro, 12, size);
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(u32(size)); o.write(ascii("mfra")); body.writeTo(o); o.write(mfro);
        file.seek(file.length());
        file.write(o.toByteArray());
    }

    // ---------------------------------------------------------------- helpers

    private interface Body { void write(ByteArrayOutputStream b) throws IOException; }

    private static void box(ByteArrayOutputStream out, String type, Body body) throws IOException { out.write(boxBytes(type, body)); }

    private static byte[] boxBytes(String type, Body body) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        body.write(b);
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(u32(8 + b.size())); o.write(ascii(type)); b.writeTo(o);
        return o.toByteArray();
    }

    private static byte[] fullBoxBytes(String type, int version, int flags, Body body) throws IOException {
        return boxBytes(type, b -> { b.write(u32((version << 24) | flags)); body.write(b); });
    }

    private static byte[] matrix(int rotation) {
        int a = 0x10000, b = 0, c = 0, d = 0x10000;
        switch (rotation) {
            case 90: a = 0; b = 0x10000; c = -0x10000; d = 0; break;
            case 180: a = -0x10000; b = 0; c = 0; d = -0x10000; break;
            case 270: a = 0; b = -0x10000; c = 0x10000; d = 0; break;
            default: break;
        }
        ByteBuffer m = ByteBuffer.allocate(36);
        m.putInt(a).putInt(b).putInt(0).putInt(c).putInt(d).putInt(0).putInt(0).putInt(0).putInt(0x40000000);
        return m.array();
    }

    private long defaultDuration(Track t) { return t.video ? VIDEO_TIMESCALE / 30 : 1024; }
    private static long usToTs(long us, int ts) { return us * ts / 1_000_000L; }
    private static long tsToUs(long v, int ts) { return v * 1_000_000L / ts; }
    private static byte[] ascii(String s) { return s.getBytes(StandardCharsets.US_ASCII); }
    private static byte[] u16(int v) { return new byte[] {(byte) (v >> 8), (byte) v}; }
    private static byte[] u32(int v) { return ByteBuffer.allocate(4).putInt(v).array(); }
    private static byte[] u64(long v) { return ByteBuffer.allocate(8).putLong(v).array(); }
    private static void putU32(byte[] a, int pos, int v) { a[pos] = (byte) (v >> 24); a[pos + 1] = (byte) (v >> 16); a[pos + 2] = (byte) (v >> 8); a[pos + 3] = (byte) v; }

    private static int indexOf(byte[] hay, byte[] needle) {
        outer:
        for (int i = 0; i <= hay.length - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) if (hay[i + j] != needle[j]) continue outer;
            return i;
        }
        return -1;
    }

    /** Splits Annex-B data into NAL units (without start codes). */
    static List<byte[]> splitAnnexB(byte[] d) {
        List<byte[]> out = new ArrayList<>();
        int i = 0, start = -1;
        while (i + 2 < d.length) {
            if (d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1) {
                if (start >= 0) {
                    int end = i;
                    while (end > start && d[end - 1] == 0) end--; // trailing zero of a 4-byte start code
                    if (end > start) out.add(java.util.Arrays.copyOfRange(d, start, end));
                }
                i += 3;
                start = i;
            } else {
                i++;
            }
        }
        if (start >= 0 && start < d.length) out.add(java.util.Arrays.copyOfRange(d, start, d.length));
        else if (start < 0 && d.length > 0) out.add(d.clone()); // already a bare NAL unit
        return out;
    }

    /** Annex-B to 4-byte length prefixes; drops parameter sets and access unit delimiters (they're in the header). */
    private static byte[] toLengthPrefixed(byte[] annexB, boolean hevc) {
        ByteArrayOutputStream o = new ByteArrayOutputStream(annexB.length + 16);
        for (byte[] n : splitAnnexB(annexB)) {
            if (n.length == 0) continue;
            int type = hevc ? (n[0] >> 1) & 0x3F : n[0] & 0x1F;
            boolean skip = hevc ? (type == 32 || type == 33 || type == 34 || type == 35) : (type == 7 || type == 8 || type == 9);
            if (skip) continue;
            o.write(n.length >> 24); o.write(n.length >> 16); o.write(n.length >> 8); o.write(n.length);
            o.write(n, 0, n.length);
        }
        return o.toByteArray();
    }

    /** Removes emulation-prevention bytes (00 00 03 -> 00 00). */
    private static byte[] unescape(byte[] n) {
        ByteArrayOutputStream o = new ByteArrayOutputStream(n.length);
        int zeros = 0;
        for (byte b : n) {
            if (zeros >= 2 && b == 3) { zeros = 0; continue; }
            o.write(b);
            zeros = b == 0 ? zeros + 1 : 0;
        }
        return o.toByteArray();
    }
}
