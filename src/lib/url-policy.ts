import dns from "node:dns/promises";
import net from "node:net";
import { FlowBridgeError } from "./errors.js";

export interface UrlPolicy {
  allowPrivateNetwork: boolean;
  /** Test seam; defaults to the system resolver. */
  lookup?: (host: string) => Promise<string[]>;
}

/** True for loopback, private, link-local, CGNAT, multicast, and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const g = expandIPv6(ip);
    if (!g) return true;
    const embedded = `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
    const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
    // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d, also covers :: and ::1) and NAT64 (64:ff9b::/96).
    if ((zeros(5) && g[5] === 0xffff) || zeros(6) || (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))) {
      return isPrivateAddress(embedded);
    }
    const first = g[0]!;
    return (
      (first & 0xffc0) === 0xfe80 || // link-local
      (first & 0xfe00) === 0xfc00 || // unique local
      (first & 0xff00) === 0xff00 // multicast
    );
  }
  return true;
}

/**
 * Validate an outbound URL: http(s) only, no embedded credentials, and (unless
 * explicitly allowed) every resolved address must be public.
 *
 * Limitation: the check resolves DNS separately from the connection, so a
 * hostile DNS server could still rebind between check and connect.
 */
export async function assertUrlAllowed(raw: string, policy: UrlPolicy): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FlowBridgeError("URL_BLOCKED", `Invalid URL: ${raw.split("?")[0]}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FlowBridgeError("URL_BLOCKED", `Protocol ${url.protocol} is not allowed (http/https only)`);
  }
  if (url.username || url.password) {
    throw new FlowBridgeError("URL_BLOCKED", "URLs with embedded credentials are not allowed; use the auth option");
  }
  if (policy.allowPrivateNetwork) return url;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host)
    ? [host]
    : await (policy.lookup ?? defaultLookup)(host).catch((e: unknown) => {
        throw new FlowBridgeError("HTTP_NETWORK", `DNS lookup failed for ${host}: ${(e as Error).message}`);
      });
  const bad = addrs.find(isPrivateAddress);
  if (bad || addrs.length === 0) {
    throw new FlowBridgeError(
      "URL_BLOCKED",
      `Host ${host} resolves to a private or reserved address; pass --allow-private-network to permit local targets`,
    );
  }
  return url;
}

async function defaultLookup(host: string): Promise<string[]> {
  const res = await dns.lookup(host, { all: true });
  return res.map((r) => r.address);
}

/** Expand any textual IPv6 address (incl. "::" and dotted tails) into 8 numeric groups. */
function expandIPv6(ip: string): number[] | null {
  let text = ip.toLowerCase().split("%")[0]!;
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const o = dotted[2]!.split(".").map(Number);
    text = `${dotted[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const [head, tail, extra] = text.split("::");
  if (extra !== undefined) return null;
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  const groups = [...h, ...Array<string>(Math.max(fill, 0)).fill("0"), ...t].map((x) => parseInt(x, 16));
  return groups.length === 8 && groups.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? groups : null;
}
