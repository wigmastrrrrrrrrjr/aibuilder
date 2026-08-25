// VPN / datacenter IP blocker — blocks known cloud/hosting provider IPs.
// Uses compact CIDR ranges for major cloud providers.
// Not 100% accurate (residential VPNs slip through) but catches the vast majority.

const CACHE_TTL = 3600000; // 1 hour
const cache = new Map();

// Known datacenter/cloud IP ranges (CIDR notation)
// Source: ip-ranges.json from each provider (abbreviated to major blocks)
const DC_RANGES = [
  // AWS
  '3.0.0.0/8', '52.0.0.0/8', '54.0.0.0/8',
  // GCP
  '34.0.0.0/8', '35.0.0.0/8',
  // Azure
  '13.0.0.0/8', '40.0.0.0/8',
  // DigitalOcean
  '104.131.0.0/16', '159.89.0.0/16', '64.237.0.0/16',
  // Linode
  '50.116.0.0/16', '139.162.0.0/16', '172.104.0.0/16',
  // Vultr
  '45.32.0.0/16', '64.235.0.0/16', '149.248.0.0/16',
  // Oracle Cloud
  '129.144.0.0/16', '138.0.0.0/8',
  // Hetzner
  '5.9.0.0/16', '162.55.0.0/16', '188.40.0.0/16',
  // Contabo
  '5.189.0.0/16', '185.12.0.0/16',
  // OVH
  '51.38.0.0/16', '145.239.0.0/16',
  // IBM Cloud
  '169.48.0.0/16', '158.175.0.0/16',
  // Alibaba Cloud
  '47.88.0.0/8', '8.218.0.0/16',
  // Scaleway
  '51.15.0.0/16', '163.172.0.0/16',
  // CoreWeave / Lambda
  '89.117.0.0/16',
  // Known VPN exit nodes (NordVPN, ExpressVPN, etc.)
  '103.224.0.0/16', '104.236.0.0/16', '185.199.0.0/16',
  '198.54.0.0/16', '209.126.0.0/16',
];

// Pre-parse CIDR ranges into [ip, mask] pairs for fast matching
const PARSED_RANGES = DC_RANGES.map(cidr => {
  const [prefix, bits] = cidr.split('/');
  const mask = ~((1 << (32 - Number(bits))) - 1) >>> 0;
  const ip = ipToNum(prefix);
  return [ip, mask];
});

function ipToNum(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function isDatacenter(ip) {
  const num = ipToNum(ip);
  for (const [rangeIp, mask] of PARSED_RANGES) {
    if ((num & mask) === (rangeIp & mask)) return true;
  }
  return false;
}

function getCached(ip) {
  const rec = cache.get(ip);
  if (rec && Date.now() - rec.ts < CACHE_TTL) return rec.blocked;
  cache.delete(ip);
  return null;
}

function setCache(ip, blocked) {
  cache.set(ip, { blocked, ts: Date.now() });
  // Evict old entries if cache grows too large
  if (cache.size > 10000) {
    const cutoff = Date.now() - CACHE_TTL;
    for (const [k, v] of cache) {
      if (v.ts < cutoff) cache.delete(k);
    }
  }
}

export function blockDatacenterIps() {
  return async (c, next) => {
    const ip = (
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      c.req.header('x-real-ip') ||
      ''
    );

    if (!ip || !ip.includes('.')) return next(); // can't check, allow

    const cached = getCached(ip);
    if (cached === true) {
      return c.json({ error: 'access denied — datacenter/VPN IPs are blocked' }, 403);
    }
    if (cached === false) return next();

    const blocked = isDatacenter(ip);
    setCache(ip, blocked);

    if (blocked) {
      return c.json({ error: 'access denied — datacenter/VPN IPs are blocked' }, 403);
    }
    return next();
  };
}
