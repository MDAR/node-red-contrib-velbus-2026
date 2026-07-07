'use strict';

/**
 * velbus-utils.js
 * Shared Velbus packet framing, checksum, and parse/build utilities.
 * Used by velbus-bridge (splitter) and velbus-relay (encoder/decoder).
 */

/**
 * Compute Velbus packet checksum.
 * Sum all bytes mod 256, return two's complement.
 */
function chk(bytes) {
  let s = 0;
  for (const x of bytes) s = (s + x) & 0xFF;
  return ((~s + 1) & 0xFF);
}

/**
 * Build a Velbus packet.
 * @param {number} pri - Priority byte (0xF8 commands, 0xFB status/RTR)
 * @param {number} addr - Module address (0x01–0xFE)
 * @param {number[]} body - Body bytes array
 * @returns {Buffer}
 */
function pkt(pri, addr, body) {
  const dlc = body.length & 0x0F;
  const h = [0x0F, pri, addr, dlc, ...body];
  return Buffer.from([...h, chk(h), 0x04]);
}

/**
 * Build an RTR (request-to-respond / bus scan) packet for a given address.
 * RTR packets have DLC=0x40 and no body.
 */
function rtrPkt(addr) {
  const h = [0x0F, 0xFB, addr, 0x40];
  return Buffer.from([...h, chk(h), 0x04]);
}

/**
 * Parse a raw Velbus packet buffer.
 * @param {Buffer} raw
 * @returns {{ pri, addr, rtr, body, cmd } | null}
 */
function parsePkt(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 6) return null;
  if (raw[0] !== 0x0F || raw[raw.length - 1] !== 0x04) return null;
  const pri = raw[1], addr = raw[2], dlc = raw[3];
  const rtr = (dlc & 0x40) !== 0;
  const bl = rtr ? 0 : (dlc & 0x0F);
  if (raw.length < 4 + bl + 2) return null;
  const body = Array.from(raw.slice(4, 4 + bl));
  return { pri, addr, rtr, body, cmd: body.length > 0 ? body[0] : null };
}

/**
 * Split a raw TCP stream buffer into complete Velbus packets.
 * Returns { packets: Buffer[], remainder: Buffer }
 * Caller is responsible for persisting remainder across TCP data events.
 */
function splitPackets(buf) {
  const packets = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] !== 0x0F) { i++; continue; }
    if (i + 3 >= buf.length) break;
    const dl = buf[i + 3];
    const rtr = (dl & 0x40) !== 0;
    const bl = rtr ? 0 : (dl & 0x0F);
    const pl = 4 + bl + 2;
    if (i + pl > buf.length) break;
    const p = buf.slice(i, i + pl);
    if (p[p.length - 1] === 0x04) packets.push(Buffer.from(p));
    i += pl;
  }
  return { packets, remainder: buf.slice(i) };
}

module.exports = { chk, pkt, rtrPkt, parsePkt, splitPackets };
