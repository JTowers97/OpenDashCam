@file:OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3Api::class)

package org.opendashcam.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.media.ThumbnailUtils
import android.util.Size
import android.util.LruCache
import android.widget.Toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.opendashcam.backup.BackupScheduler
import org.opendashcam.backup.BackupStatus
import org.opendashcam.backup.OdcEncryption
import org.opendashcam.recording.RecordingService
import org.opendashcam.settings.OdcSettings
import org.opendashcam.storage.Clip
import org.opendashcam.storage.ClipCrypto
import org.opendashcam.storage.ClipStorage
import java.io.File
import java.text.DateFormat
import java.util.Calendar
import java.util.Date

private enum class ClipFilter(val label: String) {
    ALL("All"), LOCKED("Locked"), IMPACT("Impact"), PARKING("Parking"), NOT_BACKED_UP("Not backed up")
}

private object Thumbnails {
    private val cache = LruCache<String, ImageBitmap>(120)

    suspend fun load(file: File): ImageBitmap? {
        val key = file.absolutePath + file.lastModified()
        cache.get(key)?.let { return it }
        return withContext(Dispatchers.IO) {
            // Android's own helper keeps the aspect ratio and applies the video's rotation.
            val bmp: Bitmap? = try {
                ThumbnailUtils.createVideoThumbnail(file, Size(480, 270), null)
            } catch (e: Exception) {
                // Fallback: a frame 1 s in, scaled without distortion.
                val mmr = MediaMetadataRetriever()
                try {
                    mmr.setDataSource(file.absolutePath)
                    mmr.getFrameAtTime(1_000_000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)?.let { full ->
                        val scale = 480f / maxOf(full.width, full.height)
                        Bitmap.createScaledBitmap(full, (full.width * scale).toInt().coerceAtLeast(1), (full.height * scale).toInt().coerceAtLeast(1), true)
                    }
                } catch (e2: Exception) {
                    null
                } finally {
                    try { mmr.release() } catch (_: Exception) {}
                }
            }
            bmp?.asImageBitmap()?.also { cache.put(key, it) }
        }
    }
}

@Composable
fun ClipsScreen(
    settings: OdcSettings,
    onBack: () -> Unit,
    onOpenServerClips: () -> Unit,
    onOpenMap: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val storage = remember { ClipStorage(context, settings) }
    val state by RecordingService.state.collectAsStateWithLifecycle()
    val backup by BackupStatus.state.collectAsStateWithLifecycle()
    var clips by remember { mutableStateOf(storage.allClips()) }
    var filter by remember { mutableStateOf(ClipFilter.ALL) }
    var confirmDelete by remember { mutableStateOf<Clip?>(null) }
    // Bulk selection
    var selecting by remember { mutableStateOf(false) }
    val selected = remember { mutableStateListOf<String>() }
    var confirmBulkDelete by remember { mutableStateOf(false) }
    val cryptoJob by ClipCrypto.job.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()

    // Encryption flow state
    var passphraseFor by remember { mutableStateOf<Pair<Clip, String>?>(null) } // clip + action ("play"/"decrypt")
    var setPassphraseThen by remember { mutableStateOf<List<Clip>?>(null) }
    var confirmEncryptAll by remember { mutableStateOf<List<Clip>?>(null) }
    var opening by remember { mutableStateOf<Float?>(null) }

    DisposableEffect(Unit) {
        onDispose { ClipCrypto.clearPlaybackCache(context) }
    }

    fun refresh() {
        clips = storage.allClips()
    }
    LaunchedEffect(state.segments, state.status, backup.lastSuccessAt, cryptoJob.running) { refresh() }

    fun openVideo(file: File) {
        try {
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
            val intent = Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "video/mp4")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            context.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(context, "No video player app found.", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Toast.makeText(context, "Couldn't open clip: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    fun playEncrypted(clip: Clip, passphrase: String) {
        opening = 0f
        scope.launch {
            val file = withContext(Dispatchers.IO) {
                try {
                    ClipCrypto.decryptForPlayback(context, clip, passphrase) { p -> opening = p }
                } catch (e: Exception) {
                    null
                }
            }
            opening = null
            if (file != null) openVideo(file)
            else Toast.makeText(context, "Couldn't decrypt this clip.", Toast.LENGTH_LONG).show()
        }
    }

    fun withPassphrase(clip: Clip, action: String) {
        val cached = PassphraseSession.get()
        if (cached == null) {
            passphraseFor = clip to action
            return
        }
        scope.launch {
            // Key derivation is deliberately slow, so check off the main thread.
            val ok = withContext(Dispatchers.IO) { OdcEncryption.checkPassphrase(clip.file, cached) }
            when {
                !ok -> passphraseFor = clip to action
                action == "play" -> playEncrypted(clip, cached)
                else -> ClipCrypto.decryptInPlace(listOf(clip), cached)
            }
        }
    }

    fun play(clip: Clip) {
        if (clip.encrypted) withPassphrase(clip, "play") else openVideo(clip.file)
    }

    fun encrypt(targets: List<Clip>) {
        val pass = settings.encryptionPassphrase
        if (pass.isNullOrEmpty()) setPassphraseThen = targets else ClipCrypto.encrypt(targets, pass)
    }

    val shown = clips.filter {
        when (filter) {
            ClipFilter.ALL -> true
            ClipFilter.LOCKED -> it.locked
            ClipFilter.IMPACT -> it.impact
            ClipFilter.PARKING -> it.parking
            ClipFilter.NOT_BACKED_UP -> !it.backedUp
        }
    }
    val byDay = shown.groupBy { dayStart(it.startTime) }

    Column(modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { ScreenHeader("Clips", onBack) }
            TextButton(onClick = { selecting = !selecting; selected.clear() }) { Text(if (selecting) "Done" else "Select") }
            if (settings.serverPaired && !selecting) {
                TextButton(onClick = onOpenMap) { Text("Map") }
                TextButton(onClick = onOpenServerClips) { Text("On server") }
            }
            if ((settings.smbEnabled || settings.serverPaired) && !selecting) {
                OutlinedButton(onClick = { BackupScheduler.kick(context, replace = true) }) {
                    Text(if (backup.running) "Backing up… ${(backup.progress * 100).toInt()}%" else "Back up now")
                }
            }
        }
        val locked = clips.filter { it.locked }
        Hint(
            "${clips.size} clips · ${ClipStorage.formatBytes(clips.sumOf { it.sizeBytes })} " +
                "(${locked.size} locked) · Locked clips are never replaced by loop recording."
        )
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ClipFilter.entries.forEach { f ->
                if (f != ClipFilter.NOT_BACKED_UP || settings.smbEnabled || settings.serverPaired) {
                    FilterChip(selected = filter == f, onClick = { filter = f }, label = { Text(f.label) })
                }
            }
        }

        val encryptable = shown.filter { !it.encrypted && it.file.absolutePath !in state.activeFiles }
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
            if (cryptoJob.running) {
                Column(Modifier.weight(1f)) {
                    Text(
                        "${cryptoJob.verb} ${minOf(cryptoJob.done + 1, cryptoJob.total)} of ${cryptoJob.total}…",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    LinearProgressIndicator(progress = { cryptoJob.progress }, modifier = Modifier.fillMaxWidth())
                }
            } else {
                cryptoJob.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.weight(1f)) }
                    ?: Box(Modifier.weight(1f))
                if (encryptable.isNotEmpty()) {
                    TextButton(onClick = { confirmEncryptAll = encryptable }) {
                        Text("Encrypt ${if (filter == ClipFilter.ALL) "all" else "these"} (${encryptable.size})")
                    }
                }
            }
        }

        if (selecting) {
            val picked = shown.filter { it.file.absolutePath in selected && it.file.absolutePath !in state.activeFiles }
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer), modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                Column(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
                    Text(
                        if (picked.isEmpty()) "Tap clips to select them" else "${picked.size} selected · ${ClipStorage.formatBytes(picked.sumOf { it.sizeBytes })}",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    FlowRow {
                        TextButton(onClick = {
                            selected.clear()
                            selected.addAll(shown.filter { it.file.absolutePath !in state.activeFiles }.map { it.file.absolutePath })
                        }) { Text("Select all") }
                        TextButton(enabled = picked.isNotEmpty(), onClick = { picked.filter { !it.locked }.forEach { storage.lock(it) }; selected.clear(); refresh() }) { Text("Lock") }
                        TextButton(enabled = picked.isNotEmpty(), onClick = { picked.filter { it.locked }.forEach { storage.unlock(it) }; selected.clear(); refresh() }) { Text("Unlock") }
                        if (settings.smbEnabled || settings.serverPaired) {
                            TextButton(enabled = picked.isNotEmpty(), onClick = { picked.forEach { storage.setKeep(it, true) }; selected.clear(); refresh() }) { Text("Keep on phone") }
                        }
                        TextButton(enabled = picked.any { !it.encrypted } && !cryptoJob.running, onClick = { encrypt(picked.filter { !it.encrypted }); selected.clear() }) { Text("Encrypt") }
                        TextButton(enabled = picked.isNotEmpty(), onClick = { confirmBulkDelete = true }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
                    }
                }
            }
        }

        if (shown.isEmpty()) {
            Text(
                if (clips.isEmpty()) "No clips yet. Start recording from the home screen." else "No clips match this filter.",
                modifier = Modifier.padding(top = 24.dp),
            )
        }

        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            byDay.forEach { (day, dayClips) ->
                item(key = "day-$day") {
                    Text(
                        DateFormat.getDateInstance(DateFormat.FULL).format(Date(day)) +
                            " · ${dayClips.size} clips · ${ClipStorage.formatBytes(dayClips.sumOf { it.sizeBytes })}",
                        style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(top = 12.dp, bottom = 2.dp),
                    )
                }
                items(dayClips, key = { it.file.absolutePath }) { clip ->
                    ClipRow(
                        clip = clip,
                        inProgress = clip.file.absolutePath in state.activeFiles,
                        showBackup = settings.smbEnabled || settings.serverPaired,
                        onPlay = { play(clip) },
                        onToggleLock = {
                            if (clip.locked) storage.unlock(clip) else storage.lock(clip)
                            refresh()
                        },
                        onToggleKeep = {
                            storage.setKeep(clip, !clip.keep)
                            refresh()
                        },
                        onDelete = { confirmDelete = clip },
                        onToggleEncryption = {
                            if (clip.encrypted) withPassphrase(clip, "decrypt") else encrypt(listOf(clip))
                        },
                        busy = cryptoJob.running,
                        selectMode = selecting,
                        isSelected = clip.file.absolutePath in selected,
                        onToggleSelect = {
                            val key = clip.file.absolutePath
                            if (key in selected) selected.remove(key) else selected.add(key)
                        },
                    )
                }
            }
        }
    }

    passphraseFor?.let { (clip, action) ->
        EnterPassphraseDialog(clip.file) { pass ->
            passphraseFor = null
            if (pass != null) {
                if (action == "play") playEncrypted(clip, pass) else ClipCrypto.decryptInPlace(listOf(clip), pass)
            }
        }
    }

    setPassphraseThen?.let { targets ->
        PassphraseDialog { pass ->
            setPassphraseThen = null
            if (pass != null) {
                settings.encryptionPassphrase = pass
                ClipCrypto.encrypt(targets, pass)
            }
        }
    }

    confirmEncryptAll?.let { targets ->
        AlertDialog(
            onDismissRequest = { confirmEncryptAll = null },
            title = { Text("Encrypt ${targets.size} clips?") },
            text = {
                Text(
                    "They'll only play after you enter your passphrase, and their GPS tracks are encrypted too. " +
                        "This runs in the background and may take a while for many clips. Clips recorded later aren't encrypted automatically."
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmEncryptAll = null
                    encrypt(targets)
                }) { Text("Encrypt") }
            },
            dismissButton = { TextButton(onClick = { confirmEncryptAll = null }) { Text("Cancel") } },
        )
    }

    opening?.let { ProgressDialog("Decrypting clip…", it) }

    if (confirmBulkDelete) {
        val picked = clips.filter { it.file.absolutePath in selected && it.file.absolutePath !in state.activeFiles }
        AlertDialog(
            onDismissRequest = { confirmBulkDelete = false },
            title = { Text("Delete ${picked.size} clips?") },
            text = {
                Text(
                    "They're removed from this phone, including locked ones" +
                        (if (picked.any { !it.backedUp } && (settings.smbEnabled || settings.serverPaired)) ", and ${picked.count { !it.backedUp }} aren't backed up yet" else "") +
                        ". Backed-up copies aren't affected."
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    picked.forEach { storage.delete(it) }
                    selected.clear()
                    confirmBulkDelete = false
                    refresh()
                }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmBulkDelete = false }) { Text("Cancel") } },
        )
    }

    confirmDelete?.let { clip ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text("Delete this clip?") },
            text = {
                Text(
                    "${clip.name} will be permanently deleted from this phone." +
                        if (clip.backedUp) " The backed-up copy is not affected." else ""
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    storage.delete(clip)
                    confirmDelete = null
                    refresh()
                }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("Cancel") } },
        )
    }
}

private fun dayStart(time: Long): Long = Calendar.getInstance().apply {
    timeInMillis = time
    set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
}.timeInMillis

@Composable
private fun ClipRow(
    clip: Clip,
    inProgress: Boolean,
    showBackup: Boolean,
    onPlay: () -> Unit,
    onToggleLock: () -> Unit,
    onToggleKeep: () -> Unit,
    onDelete: () -> Unit,
    onToggleEncryption: () -> Unit,
    busy: Boolean,
    selectMode: Boolean = false,
    isSelected: Boolean = false,
    onToggleSelect: () -> Unit = {},
) {
    val thumb by produceState<ImageBitmap?>(null, clip.file.absolutePath, inProgress) {
        value = if (inProgress || clip.encrypted) null else Thumbnails.load(clip.file)
    }
    Card(
        colors = CardDefaults.cardColors(
            containerColor = if (isSelected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
        ),
        modifier = Modifier.fillMaxWidth().then(if (selectMode && !inProgress) Modifier.clickable(onClick = onToggleSelect) else Modifier),
    ) {
        Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
            if (selectMode) {
                Checkbox(checked = isSelected, onCheckedChange = { onToggleSelect() }, enabled = !inProgress)
            }
            Box(
                Modifier
                    .width(144.dp)
                    .height(81.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(Color.Black)
                    .clickable(enabled = !inProgress, onClick = if (selectMode) onToggleSelect else onPlay),
                contentAlignment = Alignment.Center,
            ) {
                val t = thumb
                if (t != null) {
                    Image(t, contentDescription = "Play clip", contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                    Text("▶", color = Color.White)
                } else {
                    Text(if (inProgress) "REC" else "▶", color = if (inProgress) OdcRed else Color.White)
                }
                if (clip.encrypted) EncryptedBadge(Modifier.align(Alignment.TopStart).padding(4.dp))
            }
            Column(Modifier.padding(start = 12.dp).weight(1f)) {
                Text(
                    DateFormat.getTimeInstance(DateFormat.MEDIUM).format(Date(clip.startTime)),
                    fontWeight = FontWeight.Bold,
                )
                val tags = buildList {
                    add(clip.camera)
                    if (clip.parking) add("Parking")
                    if (clip.impact) add("⚠ Impact")
                    if (clip.locked) add("🔒 Locked")
                    if (clip.hasTrack) add("GPS")
                    if (showBackup && clip.backedUp) add("☁ Backed up")
                    if (clip.keep) add("Keep on phone")
                    add(ClipStorage.formatBytes(clip.sizeBytes))
                }
                Text(tags.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (inProgress) {
                    Text("Recording…", style = MaterialTheme.typography.bodySmall, color = OdcRed, modifier = Modifier.padding(top = 8.dp))
                } else if (!selectMode) {
                    FlowRow {
                        TextButton(onClick = onToggleLock) { Text(if (clip.locked) "Unlock" else "Lock") }
                        if (showBackup) TextButton(onClick = onToggleKeep) { Text(if (clip.keep) "Allow removal" else "Keep on phone") }
                        TextButton(onClick = onToggleEncryption, enabled = !busy) { Text(if (clip.encrypted) "Decrypt" else "Encrypt") }
                        TextButton(onClick = onDelete) { Text("Delete") }
                    }
                }
            }
        }
    }
}
