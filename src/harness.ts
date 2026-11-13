// Machine-level tools: what the computer is doing, who is using it, and the
// switches a person would reach for (volume, power, media).
//
// Everything here is read-mostly and uses the cheapest source available
// (`sysctl`, `ps`, `pmset`, `df`, `ifconfig`) rather than `system_profiler`,
// which can take seconds on a busy Mac.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appHome } from "./config.js";
import { formatBytes, formatDuration, good, failed, run, jxa, type Outcome } from "./exec.js";

// --- system_info -----------------------------------------------------------

function num(value: string | undefined): number | null {
  const n = Number((value ?? "").trim());
  return Number.isFinite(n) ? n : null;
}

export async function systemInfo(): Promise<Outcome> {
  const [sw, uname, cpu, mem, loadAvg, swap, vm, df, batt, therm] = await Promise.all([
    run("/usr/bin/sw_vers", [], { timeoutMs: 5_000 }),
    run("/usr/bin/uname", ["-m"], { timeoutMs: 5_000 }),
    run("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string", "hw.ncpu", "hw.memsize"], { timeoutMs: 5_000 }),
    run("/usr/sbin/sysctl", ["-n", "vm.swapusage"], { timeoutMs: 5_000 }),
    run("/usr/sbin/sysctl", ["-n", "vm.loadavg"], { timeoutMs: 5_000 }),
    run("/bin/ps", ["-axo", "pid=,%cpu=,%mem=,comm="], { timeoutMs: 8_000 }),
    run("/usr/bin/vm_stat", [], { timeoutMs: 5_000 }),
    run("/bin/df", ["-k", "/"], { timeoutMs: 5_000 }),
    run("/usr/bin/pmset", ["-g", "batt"], { timeoutMs: 8_000 }),
    run("/usr/bin/pmset", ["-g", "therm"], { timeoutMs: 8_000 }),
  ]);

  const product = /ProductName:\s*(.+)/.exec(sw.out)?.[1]?.trim();
  const version = /ProductVersion:\s*(.+)/.exec(sw.out)?.[1]?.trim();
  const build = /BuildVersion:\s*(.+)/.exec(sw.out)?.[1]?.trim();
  const cpuLines = cpu.out.trim().split("\n");
  const chip = cpuLines[0]?.trim();
  const cores = num(cpuLines[1]);
  const totalMem = num(cpuLines[2]);

  const load = (loadAvg.out.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  const uptimeSec = os.uptime();

  // vm_stat gives pages; page size from the header line.
  const pageSize = num(/page size of (\d+) bytes/.exec(vm.out)?.[1]) ?? 4096;
  const pages = (label: string) => {
    const m = new RegExp(`${label}:\\s*(\\d+)`).exec(vm.out);
    return m ? Number(m[1]) * pageSize : null;
  };
  const freeMem = pages("Pages free");
  const inactive = pages("Pages inactive");
  const wired = pages("Pages wired down");
  const compressed = pages("Pages occupied by compressor");

  const dfLine = df.out.trim().split("\n").pop() ?? "";
  const dfParts = dfLine.split(/\s+/);
  const diskTotal = num(dfParts[1]);
  const diskUsed = num(dfParts[2]);
  const diskFree = num(dfParts[3]);

  const swapMatch = /used = ([\d.]+)([MG])/.exec(swap.out);
  const swapUsed = swapMatch ? `${swapMatch[1]} ${swapMatch[2]}` : "?";

  const battLine = batt.out.split("\n")[1] ?? "";
  const batteryPct = /(\d+)%/.exec(battLine)?.[1];
  const charging = /charging|charged/.test(battLine);
  const source = /AC Power/.test(batt.out) ? "AC" : "battery";

  const thermal = /No thermal warning level has been recorded/.test(therm.out)
    ? "nominal (no warnings recorded)"
    : (therm.out.split("\n").find((l) => l.includes("CPU_Speed_Limit"))?.trim() ?? "nominal");

  const top = (loadAvg.ok ? mem : mem).out
    .split("\n")
    .map((line) => {
      const m = /^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.*)$/.exec(line);
      return m ? { pid: Number(m[1]), cpu: Number(m[2]), mem: Number(m[3]), comm: path.basename(m[4]) } : null;
    })
    .filter((v): v is { pid: number; cpu: number; mem: number; comm: string } => !!v)
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, 5)
    .map((p) => `    ${p.comm} (pid ${p.pid}) cpu ${p.cpu.toFixed(1)}% mem ${p.mem.toFixed(1)}%`);

  const lines = [
    `${product ?? "macOS"} ${version ?? ""}${build ? ` (build ${build})` : ""} on ${uname.out.trim() || os.arch()}`,
    `Host: ${os.hostname()}  user: ${os.userInfo().username}`,
    `Chip: ${chip ?? "?"}${cores ? `  ${cores} cores` : ""}${totalMem ? `  ${formatBytes(totalMem)} RAM` : ""}`,
    `Uptime: ${formatDuration(uptimeSec)}  load: ${load.length ? load.map((n) => n.toFixed(2)).join(" ") : "?"}`,
    freeMem !== null
      ? `Memory: ${formatBytes(freeMem)} free, ${formatBytes(inactive ?? 0)} inactive, ${formatBytes(wired ?? 0)} wired, ${formatBytes(compressed ?? 0)} compressed  swap used ${swapUsed}`
      : `Swap used ${swapUsed}`,
    diskTotal ? `Disk: ${formatBytes(diskUsed! * 1024)} used of ${formatBytes(diskTotal * 1024)} (${formatBytes(diskFree! * 1024)} free)` : "Disk: ?",
    `Power: ${source}${batteryPct ? `  battery ${batteryPct}%${charging ? " (charging)" : ""}` : ""}`,
    `Thermal: ${thermal}`,
    top.length ? `Top CPU:\n${top.join("\n")}` : "",
  ].filter(Boolean);
  return good(lines.join("\n"));
}

// --- process_list / process_control ---------------------------------------

export interface ProcessListArgs {
  filter?: string;
  sort?: "cpu" | "mem" | "pid" | "name";
  limit?: number;
}

export async function processList(args: ProcessListArgs = {}): Promise<Outcome> {
  const res = await run("/bin/ps", ["-axo", "pid=,ppid=,%cpu=,%mem=,rss=,etime=,stat=,user=,comm="], { timeoutMs: 10_000 });
  if (!res.ok) return failed(`ps failed: ${res.err}`);
  const rows = res.out
    .split("\n")
    .map((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!m) return null;
      return {
        pid: Number(m[1]),
        ppid: Number(m[2]),
        cpu: Number(m[3]),
        mem: Number(m[4]),
        rss: Number(m[5]) * 1024,
        elapsed: m[6],
        state: m[7],
        user: m[8],
        command: m[9],
      };
    })
    .filter((v): v is NonNullable<typeof v> => !!v);

  const needle = args.filter?.toLowerCase();
  const filtered = needle
    ? rows.filter((r) => `${r.command} pid=${r.pid}`.toLowerCase().includes(needle))
    : rows;
  const sort = args.sort ?? "cpu";
  filtered.sort((a, b) => {
    if (sort === "mem") return b.mem - a.mem;
    if (sort === "pid") return a.pid - b.pid;
    if (sort === "name") return a.command.localeCompare(b.command);
    return b.cpu - a.cpu;
  });
  const limit = Math.min(Math.max(1, args.limit ?? 25), 200);
  const shown = filtered.slice(0, limit);
  const lines = shown.map(
    (r) =>
      `  ${String(r.pid).padStart(6)}  cpu ${r.cpu.toFixed(1).padStart(5)}%  mem ${r.mem.toFixed(1).padStart(4)}%  ${formatBytes(r.rss).padStart(9)}  ${r.elapsed.padStart(9)}  ${r.command.slice(0, 90)}`,
  );
  const header = `${filtered.length} process(es)${needle ? ` matching "${args.filter}"` : ""}, top ${shown.length} by ${sort}`;
  return good(`${header}:\n${lines.join("\n")}`);
}

export interface ProcessControlArgs {
  action: "signal" | "stop" | "continue" | "priority" | "info";
  pid: number;
  signal?: "TERM" | "KILL" | "INT" | "HUP" | "USR1" | "USR2";
  nice?: number;
}

function isProtectedPid(pid: number): boolean {
  if (pid === process.pid || pid <= 1) return true;
  let cursor = process.pid;
  for (let i = 0; i < 8 && cursor > 1; i++) {
    if (cursor === pid) return true;
    try {
      const out = fs.readFileSync(`/proc/${cursor}/stat`, "utf8");
      cursor = Number(out.split(" ")[3]);
    } catch {
      // macOS has no /proc: ask ps for the parent instead.
      let parent = 0;
      try {
        parent = Number(execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(cursor)]).toString().trim());
      } catch {
        break;
      }
      if (!Number.isFinite(parent) || parent === cursor) break;
      cursor = parent;
    }
  }
  return false;
}

export async function processControl(args: ProcessControlArgs): Promise<Outcome> {
  if (!Number.isInteger(args.pid) || args.pid <= 0) return failed("pid must be a positive integer");
  if (args.action === "info") {
    const res = await run("/bin/ps", ["-p", String(args.pid), "-o", "pid=,ppid=,user=,%cpu=,%mem=,etime=,stat=,command="], { timeoutMs: 8_000 });
    return res.out.trim() ? good(res.out.trim()) : failed(`No process with pid ${args.pid}.`);
  }
  if (args.action !== "priority" && isProtectedPid(args.pid)) {
    return failed(`Refusing to signal pid ${args.pid}: it is this server or one of its parents.`);
  }
  if (args.action === "priority") {
    const nice = Math.round(args.nice ?? 0);
    const res = await run("/usr/bin/renice", [String(nice), "-p", String(args.pid)], { timeoutMs: 8_000 });
    return res.ok ? good(`Reniced pid ${args.pid} to ${nice}.`) : failed(res.err || res.out);
  }
  if (args.action === "stop" || args.action === "continue") {
    const sig = args.action === "stop" ? "STOP" : "CONT";
    const res = await run("/bin/kill", [`-${sig}`, String(args.pid)], { timeoutMs: 8_000 });
    return res.ok ? good(`Sent SIG${sig} to pid ${args.pid}.`) : failed(res.err || res.out);
  }
  const sig = args.signal ?? "TERM";
  const res = await run("/bin/kill", [`-${sig}`, String(args.pid)], { timeoutMs: 8_000 });
  return res.ok ? good(`Sent SIG${sig} to pid ${args.pid}.`) : failed(res.err || res.out);
}

// --- network_info ---------------------------------------------------------

async function wifiSummary(): Promise<string> {
  const ports = await run("/usr/sbin/networksetup", ["-listallhardwareports"], { timeoutMs: 10_000 });
  const blocks = ports.out.split(/\n\s*\n/);
  const wifiBlock = blocks.find((block) => /Hardware Port:\s*(Wi-Fi|AirPort)/i.test(block));
  const device = wifiBlock ? /Device:\s*(\S+)/.exec(wifiBlock)?.[1] : undefined;
  if (!device) return "not available";
  const current = await run("/usr/sbin/networksetup", ["-getairportnetwork", device], { timeoutMs: 10_000 });
  return (current.out || current.err).trim() || `interface ${device}`;
}

export async function networkInfo(): Promise<Outcome> {
  const [ifconfig, route, wifi, dns, listen] = await Promise.all([
    run("/sbin/ifconfig", ["-a"], { timeoutMs: 8_000 }),
    run("/usr/sbin/netstat", ["-rn", "-f", "inet"], { timeoutMs: 8_000 }),
    wifiSummary(),
    run("/usr/bin/scutil", ["--dns"], { timeoutMs: 8_000 }),
    run("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { timeoutMs: 15_000 }),
  ]);

  const interfaces: Array<{ name: string; ipv4: string[]; ipv6: string[]; status: string; mac?: string }> = [];
  let current: (typeof interfaces)[number] | null = null;
  for (const line of ifconfig.out.split("\n")) {
    const head = /^(\w+):\s+flags=/.exec(line);
    if (head && !/^\s/.test(line)) {
      const flags = /<([A-Z0-9,]+)>/.exec(line)?.[1] ?? "";
      current = { name: head[1], ipv4: [], ipv6: [], status: flags.includes("UP") ? "up" : "down" };
      interfaces.push(current);
      continue;
    }
    if (!current) continue;
    const inet = /^\s+inet (\d+\.\d+\.\d+\.\d+)/.exec(line);
    if (inet) current.ipv4.push(inet[1]);
    const inet6 = /^\s+inet6 (fe80::|::1|[0-9a-f:]+%?\w*)/i.exec(line);
    if (inet6 && !inet6[1].startsWith("fe80") && inet6[1] !== "::1") current.ipv6.push(inet6[1]);
    const ether = /^\s+ether ([0-9a-f:]{17})/i.exec(line);
    if (ether) current.mac = ether[1];
  }
  // Prefer interfaces that actually carry an address, but never hide a physical
  // interface that is up (its address can be on an alias).
  const withAddress = interfaces.filter((i) => i.ipv4.length || i.ipv6.length);
  const physical = interfaces.filter(
    (i) => !withAddress.includes(i) && i.status === "up" && i.mac && !i.name.startsWith("lo"),
  );
  const active = [...withAddress, ...physical].slice(0, 8);
  const routeLine = route.out.split("\n").find((l) => l.startsWith("default"));
  const gateway = routeLine?.split(/\s+/)[1];
  const ifaceName = routeLine?.split(/\s+/).pop();
  const dnsLines = Array.from(new Set((dns.out.match(/\d+\.\d+\.\d+\.\d+/g) ?? []).slice(0, 6)));

  const listening = listen.out
    .split("\n")
    .filter((l) => l.includes("LISTEN"))
    .map((l) => {
      const parts = l.split(/\s+/);
      return { command: parts[0], pid: parts[1], address: parts[parts.length - 2] };
    })
    .slice(0, 25);

  const lines: string[] = [];
  lines.push(`Gateway: ${gateway ?? "none"}${ifaceName ? ` via ${ifaceName}` : ""}`);
  if (active.length) {
    lines.push("Interfaces:");
    for (const i of active) {
      lines.push(`  ${i.name} (${i.status}) ${[...i.ipv4, ...i.ipv6].join(", ")}${i.mac ? `  mac ${i.mac}` : ""}`);
    }
  } else {
    lines.push("Interfaces: none configured");
  }
  lines.push(`Wi-Fi: ${wifi}`);
  if (dnsLines.length) lines.push(`DNS: ${dnsLines.join(", ")}`);
  if (listening.length) {
    lines.push("Listening:");
    for (const l of listening) lines.push(`  ${l.address}  ${l.command} (pid ${l.pid})`);
  }
  return good(lines.join("\n"));
}

// --- power ---------------------------------------------------------------

const CAFFEINATE_PID = path.join(appHome(), "caffeinate.pid");

export interface PowerArgs {
  action: "status" | "lock" | "sleep" | "displaySleep" | "keepAwake" | "allowSleep";
  minutes?: number;
}

export async function power(args: PowerArgs): Promise<Outcome> {
  if (args.action === "lock") {
    const res = await run(
      "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession",
      ["-suspend"],
      { timeoutMs: 10_000 },
    );
    if (res.ok) return good("Locked the screen.");
    const fallback = await run("/usr/bin/pmset", ["displaysleepnow"], { timeoutMs: 10_000 });
    return fallback.ok ? good("Display sleeping (lock unavailable on this macOS).") : failed(`lock failed: ${res.err || fallback.err}`);
  }
  if (args.action === "sleep") {
    const res = await run("/usr/bin/pmset", ["sleepnow"], { timeoutMs: 10_000 });
    return res.ok ? good("Put the Mac to sleep.") : failed(res.err || res.out);
  }
  if (args.action === "displaySleep") {
    const res = await run("/usr/bin/pmset", ["displaysleepnow"], { timeoutMs: 10_000 });
    return res.ok ? good("Display asleep.") : failed(res.err || res.out);
  }
  if (args.action === "keepAwake") {
    const minutes = Math.min(Math.max(1, Math.round(args.minutes ?? 30)), 24 * 60);
    const existing = readCaffeinatePid();
    if (existing) return good(`Already keeping the Mac awake (caffeinate pid ${existing}).`);

    // keepAwake is intentionally persistent: it must survive the short-lived
    // task worker that requested it. Give caffeinate its own process group and
    // record that exact pid instead of discovering a possibly unrelated one.
    const child = spawn("/usr/bin/caffeinate", ["-dimsu", "-t", String(minutes * 60)], {
      detached: true,
      stdio: "ignore",
    });
    const started = await new Promise<{ pid?: number; error?: Error }>((resolve) => {
      child.once("spawn", () => resolve({ pid: child.pid }));
      child.once("error", (error) => resolve({ error }));
    });
    if (started.error || !started.pid) {
      return failed(`Could not start caffeinate: ${started.error?.message ?? "no pid returned"}`);
    }
    child.unref();
    fs.mkdirSync(path.dirname(CAFFEINATE_PID), { recursive: true, mode: 0o700 });
    fs.writeFileSync(CAFFEINATE_PID, String(started.pid), { mode: 0o600 });
    return good(`Keeping the Mac awake for ${minutes} minute(s) (caffeinate pid ${started.pid}).`);
  }
  if (args.action === "allowSleep") {
    const pid = readCaffeinatePid();
    if (pid) {
      await run("/bin/kill", [pid], { timeoutMs: 5_000 });
      try {
        fs.unlinkSync(CAFFEINATE_PID);
      } catch {
        /* already gone */
      }
      return good(`Stopped caffeinate (pid ${pid}); normal sleep is allowed again.`);
    }
    const res = await run("/usr/bin/pkill", ["-f", "caffeinate -dimsu"], { timeoutMs: 5_000 });
    return res.code === 0 ? good("Stopped caffeinate.") : good("No caffeinate was running.");
  }
  const [settings, batt, pid] = await Promise.all([
    run("/usr/bin/pmset", ["-g"], { timeoutMs: 8_000 }),
    run("/usr/bin/pmset", ["-g", "batt"], { timeoutMs: 8_000 }),
    Promise.resolve(readCaffeinatePid()),
  ]);
  const source = /AC Power/.test(batt.out) ? "AC power" : /Battery Power/.test(batt.out) ? "battery" : "unknown";
  const percent = /(\d+)%/.exec(batt.out.split("\n")[1] ?? "")?.[1];
  return good(
    `Power source: ${source}${percent ? `, battery ${percent}%` : ""}\nKeep awake: ${pid ? `yes (caffeinate pid ${pid})` : "no"}\n` +
      (settings.out.split("\n").filter((l) => /displaysleep|sleep\s|hibernatemode/.test(l)).slice(0, 4).join("\n") || ""),
  );
}

function readCaffeinatePid(): string | null {
  try {
    const pid = fs.readFileSync(CAFFEINATE_PID, "utf8").trim();
    if (!pid) return null;
    process.kill(Number(pid), 0);
    return pid;
  } catch {
    return null;
  }
}

// --- audio ---------------------------------------------------------------

export interface AudioArgs {
  action: "get" | "set" | "mute" | "unmute";
  level?: number;
}

export async function audio(args: AudioArgs): Promise<Outcome> {
  if (args.action === "get") {
    const res = await run("/usr/bin/osascript", ["-e", "get volume settings"], { timeoutMs: 10_000 });
    if (!res.ok) return failed(res.err || res.out);
    return good(`Volumes: ${res.out.trim()}`);
  }
  if (args.action === "set") {
    const level = Math.round(args.level ?? 50);
    if (level < 0 || level > 100) return failed("level must be 0-100");
    const res = await run("/usr/bin/osascript", ["-e", `set volume output volume ${level}`], { timeoutMs: 10_000 });
    return res.ok ? good(`Output volume set to ${level}.`) : failed(res.err || res.out);
  }
  const muted = args.action === "mute";
  const res = await run("/usr/bin/osascript", ["-e", `set volume output muted ${muted ? "true" : "false"}`], { timeoutMs: 10_000 });
  return res.ok ? good(muted ? "Muted." : "Unmuted.") : failed(res.err || res.out);
}

// --- speak ---------------------------------------------------------------

export interface SpeakArgs {
  text: string;
  voice?: string;
  rate?: number;
  wait?: boolean;
}

export async function speak(args: SpeakArgs): Promise<Outcome> {
  const text = (args.text ?? "").slice(0, 4000);
  if (!text.trim()) return failed("text is empty");
  const flags: string[] = [];
  if (args.voice) flags.push("-v", args.voice);
  if (typeof args.rate === "number") flags.push("-r", String(Math.round(args.rate)));
  const res = await run("/usr/bin/say", [...flags, text], { timeoutMs: args.wait ? 120_000 : 15_000 });
  if (!res.ok) return failed(`say failed: ${res.err || res.out}`);
  return good(`Said ${text.length} character(s)${args.wait ? " and finished" : ""}.`);
}

export async function voices(): Promise<Outcome> {
  const res = await run("/usr/bin/say", ["-v", "?"], { timeoutMs: 10_000 });
  if (!res.ok) return failed(res.err || res.out);
  return good(res.out.split("\n").slice(0, 40).join("\n"));
}

// --- media ---------------------------------------------------------------

export interface MediaArgs {
  action: "status" | "play" | "pause" | "toggle" | "next" | "previous";
  app?: "Music" | "Spotify";
}

export async function media(args: MediaArgs): Promise<Outcome> {
  const candidates: Array<"Music" | "Spotify"> = args.app ? [args.app] : ["Spotify", "Music"];
  let target: "Music" | "Spotify" | null = null;
  for (const candidate of candidates) {
    const res = await run("/usr/bin/pgrep", ["-x", candidate], { timeoutMs: 5_000 });
    if (res.out.trim()) {
      target = candidate;
      break;
    }
  }
  if (!target) {
    return failed(`No media app running. Start ${candidates[0]} (or Music) first, or pass app.`);
  }
  const script =
    args.action === "status"
      ? `tell application "${target}"
  if it is running then
    set stateText to (player state as text)
    try
      set trackName to name of current track
      set artistName to artist of current track
      return stateText & " | " & artistName & " - " & trackName
    on error
      return stateText
    end try
  end if
end tell`
      : args.action === "toggle"
        ? `tell application "${target}" to playpause`
        : args.action === "play"
          ? `tell application "${target}" to play`
          : args.action === "pause"
            ? `tell application "${target}" to pause`
            : args.action === "next"
              ? `tell application "${target}" to next track`
              : `tell application "${target}" to previous track`;
  const res = await run("/usr/bin/osascript", ["-e", script], { timeoutMs: 20_000 });
  if (!res.ok) return failed(`media ${args.action} failed: ${res.err || res.out}`);
  const value = res.out.trim();
  if (args.action === "status") return good(`${target}: ${value || "no track"}`);
  return good(`${target}: ${args.action} ok${value ? ` (${value})` : ""}.`);
}
