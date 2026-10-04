import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';

/**
 * A small MQTT 3.1.1 client (publish only, QoS 0), enough to talk to Home Assistant's broker.
 * Reconnects with backoff, keeps the connection alive with pings, and sets a "last will" so subscribers
 * see the server as offline if it disappears. Retained messages are re-sent after reconnecting.
 *   mqtt://host[:1883]   or   mqtts://host[:8883]  (TLS)
 */
const encLen = (n) => {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
};
const str = (s) => {
  const b = Buffer.from(String(s), 'utf8');
  const l = Buffer.alloc(2);
  l.writeUInt16BE(b.length);
  return Buffer.concat([l, b]);
};
const packet = (type, body) => Buffer.concat([Buffer.from([type]), encLen(body.length), body]);

export class MqttClient extends EventEmitter {
  constructor(url, { username, password, clientId, will, keepalive = 60, rejectUnauthorized = true } = {}) {
    super();
    this.url = new URL(url);
    this.opts = { username, password, clientId: clientId || `odc-${Math.random().toString(36).slice(2, 10)}`, will, keepalive, rejectUnauthorized };
    this.connected = false;
    this.closed = false;
    this.retained = new Map(); // topic -> payload, re-sent after reconnecting
    this.backoff = 2000;
    this.lastError = null;
    this.connect();
  }

  connect() {
    if (this.closed) return;
    const secure = this.url.protocol === 'mqtts:';
    const port = Number(this.url.port) || (secure ? 8883 : 1883);
    const host = this.url.hostname;
    const sock = secure ? tls.connect({ host, port, servername: host, rejectUnauthorized: this.opts.rejectUnauthorized }) : net.connect({ host, port });
    this.sock = sock;
    let buf = Buffer.alloc(0);
    sock.setNoDelay(true);
    sock.once(secure ? 'secureConnect' : 'connect', () => sock.write(this.connectPacket()));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        let len = 0, mult = 1, i = 1, b;
        do { if (i >= buf.length) return; b = buf[i++]; len += (b & 0x7f) * mult; mult *= 128; } while (b & 0x80);
        if (buf.length < i + len) return;
        this.onPacket(buf[0] >> 4, buf.subarray(i, i + len));
        buf = buf.subarray(i + len);
      }
    });
    sock.on('error', (e) => { this.lastError = e.message; });
    sock.on('close', () => {
      const was = this.connected;
      this.connected = false;
      clearInterval(this.pinger);
      if (was) this.emit('disconnect');
      if (!this.closed) {
        setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(60_000, this.backoff * 2);
      }
    });
  }

  connectPacket() {
    const o = this.opts;
    let flags = 0x02; // clean session
    const payload = [str(o.clientId)];
    if (o.will) {
      flags |= 0x04 | (o.will.retain ? 0x20 : 0);
      payload.push(str(o.will.topic), str(o.will.payload));
    }
    if (o.username) { flags |= 0x80; payload.push(str(o.username)); }
    if (o.password) { flags |= 0x40; payload.push(str(o.password)); }
    const ka = Buffer.alloc(2);
    ka.writeUInt16BE(o.keepalive);
    return packet(0x10, Buffer.concat([str('MQTT'), Buffer.from([4, flags]), ka, ...payload]));
  }

  onPacket(type, body) {
    if (type === 2) { // CONNACK
      const rc = body[1];
      if (rc !== 0) {
        // Mosquitto (Home Assistant's broker) answers a wrong password with 5, "not authorized".
        this.lastError = ['', 'the broker doesn’t support MQTT 3.1.1', 'client ID rejected', 'broker unavailable',
          'wrong username or password', 'not authorized: check the username and password'][rc] || `refused (code ${rc})`;
        this.sock.destroy();
        return;
      }
      this.connected = true;
      this.backoff = 2000;
      this.lastError = null;
      this.pinger = setInterval(() => this.sock.write(Buffer.from([0xc0, 0x00])), (this.opts.keepalive * 1000) / 2);
      for (const [t, p] of this.retained) this.sock.write(this.publishPacket(t, p, true));
      this.emit('connect');
    }
    // PINGRESP (13) and anything else: nothing to do
  }

  publishPacket(topic, payload, retain) {
    const body = Buffer.concat([str(topic), Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')]);
    return packet(0x30 | (retain ? 1 : 0), body);
  }

  /** Publishes (QoS 0). Retained messages are remembered and re-sent after a reconnect; an empty retained message deletes. */
  publish(topic, payload, { retain = false } = {}) {
    if (retain) {
      if (payload === '' || payload == null) this.retained.delete(topic);
      else this.retained.set(topic, payload);
    }
    if (this.connected) this.sock.write(this.publishPacket(topic, payload ?? '', retain));
  }

  close() {
    this.closed = true;
    clearInterval(this.pinger);
    if (this.connected) this.sock.write(Buffer.from([0xe0, 0x00]));
    this.sock?.end();
  }
}
