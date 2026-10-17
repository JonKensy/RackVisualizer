// Pure data transforms for rack layout. Location strings (read from iDRAC or
// entered for switches) are treated as untrusted text: they are matched with
// anchored regexes and only ever surfaced in the browser via textContent,
// never as HTML. No outbound calls or file access happen here.

export function modelHeight(model) {
  if (typeof model === 'string') {
    if (/R6\d{2}/i.test(model)) return { heightU: 1, unknownModel: false };
    if (/R7\d{2}/i.test(model)) return { heightU: 2, unknownModel: false };
  }
  return { heightU: 1, unknownModel: true };
}

function walkStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) walkStrings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) walkStrings(v, out);
  return out;
}

// Canonical location lives on the Chassis: Location.Info is semicolon-separated
// "DataCenter;RoomName;Aisle;RackName;RackSlot", with Placement as a fallback.
function chassisLocation(chassis) {
  const loc = chassis?.Location;
  if (!loc) return null;
  const segments = typeof loc.Info === 'string' ? loc.Info.split(';').map((s) => s.trim()) : [];
  const [datacenter, room, aisle, rackName, rackSlot] = segments;
  const placement = loc.Placement ?? {};
  const rack = rackName || placement.Rack || '';
  const slot = Number(rackSlot) || Number(placement.RackOffset) || 0;
  const meaningful = [datacenter, room, aisle, rack].some((v) => v && v !== '0') || slot > 0;
  if (!meaningful) return null;
  const parts = [datacenter, room, rack].filter((v) => v && v !== '0');
  if (slot > 0) parts.push(`RU${slot}`);
  return parts.join(' ');
}

export function extractLocation(system, chassis, dellAttributes) {
  const sysLoc = dellAttributes?.['SystemInfo.1.SysLocation'];
  if (typeof sysLoc === 'string' && sysLoc.trim()) return sysLoc;
  const fromChassis = chassisLocation(chassis);
  if (fromChassis) return fromChassis;
  const direct = [system.AssetTag, system.Location?.PartLocation?.Reference];
  for (const v of direct) {
    if (typeof v === 'string' && /RU\s*\d+/i.test(v)) return v;
  }
  const matches = walkStrings(system).filter((s) => /RU\s*\d+/i.test(s));
  if (matches.length === 0) return null;
  return matches.reduce((a, b) => (b.length > a.length ? b : a));
}

export function parseLocation(raw) {
  if (!raw) return null;
  const rackMatch = raw.match(/Rack\s*(\d+)/i);
  const ruMatch = raw.match(/RU\s*(\d+)/i);

  let datacenter = null;
  let env = null;
  if (rackMatch) {
    const prefix = raw.slice(0, rackMatch.index).trim().replace(/[_\s]+$/, '');
    if (prefix) {
      const parts = prefix.split(/[_\s]+/);
      env = parts.pop() ?? null;
      datacenter = parts.join(' ') || null;
    }
  }
  return {
    datacenter,
    env,
    rackNumber: rackMatch ? parseInt(rackMatch[1], 10) : null,
    ru: ruMatch ? parseInt(ruMatch[1], 10) : null,
  };
}

export function buildServer(host, serviceTag, system, chassis, dellAttributes) {
  const model = system.Model ?? chassis?.Model ?? null;
  const { heightU, unknownModel } = modelHeight(model);
  const locationRaw = extractLocation(system, chassis, dellAttributes);
  const parsed = parseLocation(locationRaw);
  const warnings = [];
  if (unknownModel) warnings.push('unknown model');
  if (!locationRaw) warnings.push('no location set');
  else if (parsed.rackNumber == null || parsed.ru == null) warnings.push('unparseable location');
  return { kind: 'server', host, serviceTag, model, heightU, locationRaw, ...parsed, warnings };
}

export function buildRacks(servers, errors) {
  const groups = new Map();
  const unassigned = [];

  for (const s of servers) {
    if (s.rackNumber == null || s.ru == null || s.ru < 1) {
      unassigned.push(s);
      continue;
    }
    const key = `${s.datacenter ?? ''}|${s.env ?? ''}|${s.rackNumber}`;
    if (!groups.has(key)) {
      groups.set(key, { datacenter: s.datacenter, env: s.env, rackNumber: s.rackNumber, servers: [] });
    }
    groups.get(key).servers.push(s);
  }

  for (const group of groups.values()) {
    const occupancy = new Map();
    for (const s of group.servers) {
      const top = s.ru + s.heightU - 1;
      if (top > 42) s.warnings.push('out of range');
      for (let u = s.ru; u <= Math.min(top, 42); u++) {
        if (occupancy.has(u)) {
          s.overlap = true;
          occupancy.get(u).overlap = true;
        } else {
          occupancy.set(u, s);
        }
      }
    }
    group.servers.sort((a, b) => a.ru - b.ru);
  }

  const racks = [...groups.values()].sort((a, b) => a.rackNumber - b.rackNumber);
  return { racks, unassigned, errors };
}
