/*
 * DeviceKeeper 后端服务
 * 纯 Node 内置模块,零 npm 依赖。
 * 职责:HTTP API(仅 127.0.0.1:3618)+ 设备枚举 + 注册表守护 + 计划任务管理。
 * 运行方式:
 *   - 直接运行(需管理员才能写注册表;非管理员自动进入只读模式)
 *   - 由 DeviceKeeper.exe(托盘)或计划任务拉起
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

/* ============ 常量与目录 ============ */
const PORT = Number(process.env.DK_PORT || 3618);   // 可用环境变量 DK_PORT 覆盖(便于并行测试/避让端口冲突)
const HOST = '127.0.0.1';
const ENUM_ROOT = 'HKLM\\SYSTEM\\CurrentControlSet\\Enum';
const REMOVABLE_BIT = 4;              // Capabilities bit2:可移动(可清除 → 让设备不再"可移除")
const EJECT_BIT = 2;                  // Capabilities bit1:支持弹出
/* 托盘判据核心位:SurpriseRemovalOK。
   微软文档:托盘只列出"支持安全删除"的设备;该位为 1 表示设备可被意外拔出、无需安全删除,
   因此不会出现在托盘。实测 55 台设备完美印证:凡进托盘的(WiFi/Billboard)此位均为 0,
   凡不进托盘的(集线器/摄像头/音频/HID)此位均为 1。 */
const SURPRISE_BIT = 0x80;
/* 守护手法:
   clear-removable = 原值 -4,清除可移动位(博客方法,适用于带 REMOVABLE 位的设备)
   mark-surprise   = 原值 +0x80,标记为"可意外拔出"(适用于无 REMOVABLE 位的设备,如 WiFi/Billboard) */
const METHOD_CLEAR_REMOVABLE = 'clear-removable';
const METHOD_MARK_SURPRISE = 'mark-surprise';
const EXCLUDE_MODES = ['strict', 'relaxed', 'off'];
const GUARD_INTERVAL_MS = 5000;       // 守护循环周期
const LOG_MAX_BYTES = 1024 * 1024;    // 日志超过 1MB 截断
const TASK_SERVICE = 'DeviceKeeper Service';
const TASK_TRAY = 'DeviceKeeper Tray';

const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const DATA_DIR = path.join(process.env.ProgramData || 'C:\\ProgramData', 'DeviceKeeper');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const TOKEN_FILE = path.join(DATA_DIR, 'token');
const LOG_FILE = path.join(DATA_DIR, 'logs', 'app.log');

/* 实例 ID 白名单:仅允许 USB\ 与 USBSTOR\ 前缀的安全字符,防注入 */
const INSTANCE_ID_RE = /^(USB|USBSTOR)\\[A-Za-z0-9_&\\.\\-]+$/;

/* ============ 状态 ============ */
const state = {
  startedAt: new Date().toISOString(),
  isAdmin: null,          // null=尚未检测
  engine: false,          // 守护引擎开关
  autoFixCount: 0,        // 累计自动修复次数
  protected: {},          // { 实例ID: { original, hwidPrefix, storage } }
  logMem: [],             // 内存中的最近日志(UI 用)
  sessionLogFile: null,   // 本次会话的独立日志文件
  boot: false,            // 开机自启状态(启动时检测,setBoot 时更新)
  excludeMode: 'relaxed', // 排除强度:strict(严格) / relaxed(宽松,默认) / off(关闭排除)
  autoApply: true,        // 守护成功后自动重启该设备,让注册表变更立即生效
};

function pad2(n){ return n < 10 ? '0' + n : '' + n; }
function nowStamp(){
  const d = new Date();
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

/* ============ 基础工具 ============ */
function ensureDirs() {
  for (const d of [DATA_DIR, BACKUP_DIR, path.dirname(LOG_FILE)]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function log(level, msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] [${level}] ${msg}`;
  console.log(line);
  try {
    // 超过 1MB 时截断重开,防无限增长(教室机常年不关)
    try {
      const st = fs.statSync(LOG_FILE);
      if (st.size > LOG_MAX_BYTES) fs.writeFileSync(LOG_FILE, '');
    } catch (e) { /* 文件尚不存在 */ }
    fs.appendFileSync(LOG_FILE, line + '\r\n');
    // 同时写本次会话的独立日志文件,方便打包带走
    if (state.sessionLogFile) fs.appendFileSync(state.sessionLogFile, line + '\r\n');
  } catch (e) { /* 日志写失败不致命 */ }
  state.logMem.push({ time: new Date().toISOString(), level, msg });
  if (state.logMem.length > 300) state.logMem.splice(0, state.logMem.length - 300);
}

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    state.engine = !!c.engine;
    state.autoFixCount = c.autoFixCount || 0;
    state.protected = c.protected || {};
    if (EXCLUDE_MODES.indexOf(c.excludeMode) >= 0) state.excludeMode = c.excludeMode;
    if (typeof c.autoApply === 'boolean') state.autoApply = c.autoApply;
  } catch (e) {
    /* 首次运行无配置,保持默认 */
  }
}

function saveConfig() {
  const c = {
    version: 1,
    engine: state.engine,
    autoFixCount: state.autoFixCount,
    protected: state.protected,
    excludeMode: state.excludeMode,
    autoApply: state.autoApply,
    updatedAt: new Date().toISOString(),
  };
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}

/* execFile 封装:参数数组传递,永不走 shell,杜绝命令注入 */
function run(cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err }));
    } catch (e) {
      // spawn 同步失败(如被系统安全策略拦截)也按失败返回,不让上层 API 崩溃
      resolve({ ok: false, stdout: '', stderr: String((e && e.message) || e), err: e });
    }
  });
}

function regQueryValue(key, valueName) {
  return run('reg', ['query', key, '/v', valueName]);
}

/* ============ 令牌 ============ */
function ensureToken() {
  let token = '';
  try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) { /* 无则生成 */ }
  if (!token || !/^[A-Za-z0-9]{32,}$/.test(token)) {
    token = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(TOKEN_FILE, token, { flag: 'w' });
  }
  // 授权 Users 只读,保证托盘程序(用户会话)能读到令牌打开 UI
  await_run_icacls(token);
  return token;
}
function await_run_icacls(token) {
  run('icacls', [TOKEN_FILE, '/grant', 'Users:R']).then(() => {});
}

function checkToken(req, urlObj) {
  const t = urlObj.searchParams.get('token') || req.headers['x-token'] || '';
  const a = Buffer.from(String(t));
  const b = Buffer.from(String(TOKEN));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ============ 管理员检测(net session 失败即非管理员) ============ */
async function detectAdmin() {
  const r = await run('net', ['session']);
  state.isAdmin = r.ok;
  log('INFO', '权限检测:' + (r.ok ? '管理员(可读写)' : '标准用户(只读模式)'));
}

/* ============ 设备枚举 ============ */
/* 主数据源:reg query 全量解析(值名 Capabilities/FriendlyName/DeviceDesc/Class 均为固定英文,
   不随系统语言变化,中文 Windows 上也可靠)。pnputil 仅做"在线"辅助判断。 */

/* 去掉 "@oemXX.inf,%idx%;" 前缀,拿到友好名称 */
function cleanName(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^@[^,]*,\s*%[^%]*%;?\s*/, '');
  const idx = s.lastIndexOf(';');
  if (idx >= 0 && idx < s.length - 1) s = s.slice(idx + 1).trim();
  return s || String(raw || '');
}

/* 解析 reg query /s 输出,提取所有"实例层"键(USB\VID&PID\实例)及其值 */
async function enumRegInstances() {
  const result = [];
  for (const prefix of ['USB', 'USBSTOR']) {
    const r = await run('reg', ['query', ENUM_ROOT + '\\' + prefix, '/s']);
    if (!r.ok) {
      log('WARN', 'reg 枚举 ' + prefix + ' 失败:' + (r.stderr || '').trim());
      continue;
    }
    const before = result.length;
    let cur = null;
    for (const raw of r.stdout.split(/\r?\n/)) {
      const line = raw.trim();
      const m = line.match(/^HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Enum\\(USB|USBSTOR)\\(.+)$/i);
      if (m) {
        // rest 恰好两段 = 实例层;更深(Device Parameters/Properties)或更浅(枚举器)都跳过
        if (m[2].split('\\').length === 2) {
          const id = m[1].toUpperCase() + '\\' + m[2];
          cur = { id, vals: {} };
          result.push(cur);
        } else {
          cur = null;
        }
      } else if (cur) {
        const v = line.match(/^(\S+)\s+REG_(DWORD|SZ)\s+(.+)$/);
        if (v) cur.vals[v[1]] = v[3];
      }
    }
    log('INFO', prefix + ' 分支枚举 ' + (result.length - before) + ' 个实例');
  }
  return result;
}

/* 拿"当前在线(present)"实例 ID 集合。
   首选 PowerShell Get-PnpDevice(不依赖本地化文本,最可靠);
   回退 pnputil(标签兼容中英文);都失败返回 null(表示无法判断在线,调用方将视为全部在线)。 */
async function getPnpInfo() {
  // 用 Get-PnpDevice 一次拿到:在线实例集合 + 每个实例的 Class(注册表实例键里没有 Class 值)
  const ps = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive', '-Command',
    'Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Select-Object InstanceId,Class | ConvertTo-Json -Compress']);
  if (ps.ok && ps.stdout.trim()) {
    try {
      const arr = JSON.parse(ps.stdout);
      const list = Array.isArray(arr) ? arr : [arr];
      const presentIds = new Set();
      const clsMap = new Map();
      for (const d of list) {
        if (!d.InstanceId) continue;
        const id = String(d.InstanceId).toUpperCase();
        if (!/^(USB|USBSTOR)\\/.test(id)) continue;
        presentIds.add(id);
        if (d.Class) clsMap.set(id, String(d.Class));
      }
      if (presentIds.size > 0) {
        log('INFO', '在线检测:Get-PnpDevice 返回 ' + presentIds.size + ' 个 USB/USBSTOR 实例');
        return { presentIds, clsMap };
      }
      log('WARN', 'Get-PnpDevice 返回为空,尝试 pnputil');
    } catch (e) {
      log('WARN', 'Get-PnpDevice JSON 解析失败:' + e.message);
    }
  }
  const p = await run('pnputil', ['/enum-devices', '/connected']);
  if (p.ok) {
    const presentIds = new Set();
    for (const raw of p.stdout.split(/\r?\n/)) {
      const m = raw.trim().match(/^(Instance ID|实例 ?ID|InstanceID):\s*(.+)$/i);
      if (m && /^(USB|USBSTOR)\\/.test(m[2].trim())) presentIds.add(m[2].trim().toUpperCase());
    }
    if (presentIds.size > 0) {
      log('INFO', '在线检测:pnputil 返回 ' + presentIds.size + ' 个实例');
      return { presentIds, clsMap: new Map() };
    }
    log('WARN', 'pnputil 也未解析到实例');
  }
  log('WARN', '在线检测不可用,显示全部可弹出设备');
  return null;
}

async function getCapabilities(instanceId) {
  const key = ENUM_ROOT + '\\' + instanceId;
  const r = await regQueryValue(key, 'Capabilities');
  if (!r.ok) return null;
  const m = r.stdout.match(/Capabilities\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
  return m ? parseInt(m[1], 16) : null;
}

/* 取设备友好名称(FriendlyName 优先,回退 DeviceDesc) */
async function getDeviceName(instanceId) {
  const key = ENUM_ROOT + '\\' + instanceId;
  const r1 = await regQueryValue(key, 'FriendlyName');
  let nm = r1.ok ? ((r1.stdout.match(/FriendlyName\s+REG_SZ\s+(.+)/i) || [])[1] || '').trim() : '';
  if (!nm) {
    const r2 = await regQueryValue(key, 'DeviceDesc');
    nm = r2.ok ? ((r2.stdout.match(/DeviceDesc\s+REG_SZ\s+(.+)/i) || [])[1] || '').trim() : '';
  }
  return cleanName(nm);
}

/* 按设备特征推断类别(只决定 UI 图标与标签,不影响是否显示) */
function inferKind(instanceId, name, cls) {
  const n = (name || '').toLowerCase();
  const c = (cls || '').toLowerCase();
  if (instanceId.startsWith('USBSTOR\\')) {
    return /hard\s?disk|hdd|drive.*ext/.test(n) ? 'hdd' : 'usb';
  }
  if (c === 'bluetooth' || /bluetooth|蓝牙/.test(n)) return 'bt';
  if (c === 'net' && /wireless|wi-?fi|wlan|802\.11|无线/.test(n)) return 'wifi';
  // 集线器:名称含 hub/集线器 即认定,不依赖设备类(兼容各种芯片厂商命名)
  if (/hub|集线器/.test(n)) return 'hub';
  if (c === 'usb' && /storage|mass|存储|大容量/.test(n)) return 'usb';        // U盘父设备
  if (/receiver|dongle|unifying|接收器/.test(n)) return 'dongle';
  return 'periph';
}

const KIND_TAG = {
  wifi: '无线网卡', bt: '蓝牙', hub: '集线器', usb: 'U盘 · 存储',
  hdd: '移动硬盘 · 存储', dongle: '接收器', periph: '外设',
};

/* 收集所有"存储子设备"的父序列号:
   扫描 USBSTOR(BOT 协议)与 SCSI(UASP 协议)分支里的 ParentIdPrefix 值,
   该值等于其 USB 父设备实例的序列号段,用于反推哪些 USB 设备是 U盘/移动硬盘。 */
async function collectStoragePrefixes() {
  const prefixes = new Set();
  for (const branch of ['USBSTOR', 'SCSI']) {
    const r = await run('reg', ['query', ENUM_ROOT + '\\' + branch, '/s']);
    if (!r.ok) continue;
    for (const raw of r.stdout.split(/\r?\n/)) {
      const m = raw.trim().match(/^ParentIdPrefix\s+REG_SZ\s+(.+)$/i);
      if (m) prefixes.add(m[1].trim().toUpperCase());
    }
  }
  return prefixes;
}

/* 取 USB 实例的序列号段(实例 ID 的第三段) */
function serialOf(instanceId) {
  const parts = instanceId.split('\\');
  return parts.length >= 3 ? parts[2] : '';
}

/* 把 Capabilities 数值解码成可读的位标志列表,便于排查"为什么显示/不显示" */
function capBits(cap) {
  const names = [
    [0x01, 'LOCK_SUPPORTED'], [EJECT_BIT, 'EJECT_SUPPORTED'], [REMOVABLE_BIT, 'REMOVABLE'],
    [0x08, 'DOCK_DEVICE'], [0x10, 'UNIQUE_ID'], [0x20, 'SILENT_INSTALL'],
    [0x40, 'RAW_DEVICE_OK'], [SURPRISE_BIT, 'SURPRISE_REMOVAL_OK'],
  ];
  const on = names.filter(function (b) { return (cap & b[0]) !== 0; }).map(function (b) { return b[1]; });
  return '0x' + cap.toString(16).toUpperCase() + '(' + cap + ') [' + on.join('|') + ']';
}

async function listDevices() {
  const info = await getPnpInfo();   // { presentIds, clsMap } 或 null
  const presentIds = info ? info.presentIds : null;
  const clsMap = info ? info.clsMap : new Map();
  const instances = await enumRegInstances();

  // U盘/移动硬盘的 USB 父实例:其序列号段 == 某存储子设备(USBSTOR 或 SCSI)的 ParentIdPrefix
  const storagePrefixes = await collectStoragePrefixes();
  log('INFO', '========== 设备枚举明细开始 ==========');
  log('INFO', '枚举到实例 ' + instances.length + ' 个 | 存储父前缀 ' + storagePrefixes.size + ' 个 | 在线清单 ' +
      (presentIds === null ? '不可用' : presentIds.size + ' 个'));

  /* ===== 托盘可见性与排除强度 =====
     trayVisible:设备是否会被 Windows 列进「安全删除硬件」——判据是 SURPRISE_REMOVAL_OK 未置位。
     shouldList :在当前排除强度下是否展示给用户:
       strict  严格——只保留经典"可移除且需安全删除"的设备(REMOVABLE 置位且 SURPRISE 未置位)
       relaxed 宽松——等价于系统托盘规则(SURPRISE 未置位),默认;WiFi/Billboard 等在此模式可见
       off     关闭排除——不按能力位过滤,全部在线 USB 设备都列出,交给用户人工判断 */
  const MODE_LABEL = { strict: '严格', relaxed: '宽松', off: '关闭排除' };
  const mode = state.excludeMode;
  function trayVisible(cap) { return (cap & SURPRISE_BIT) === 0; }
  function shouldList(cap) {
    if (mode === 'off') return true;
    if (mode === 'strict') return (cap & REMOVABLE_BIT) !== 0 && trayVisible(cap);
    return trayVisible(cap);   // relaxed
  }

  const candidates = [];
  let statNoCap = 0, statExcluded = 0;
  for (const it of instances) {
    const capHex = String(it.vals.Capabilities || '').match(/0x([0-9a-fA-F]+)/);
    const name = cleanName(it.vals.FriendlyName || it.vals.DeviceDesc || it.id);
    const cls = clsMap.get(it.id.toUpperCase()) || it.vals.Class || '(无)';
    const online = presentIds === null ? '未知' : (presentIds.has(it.id.toUpperCase()) ? '在线' : '离线');
    const isProtected = !!state.protected[it.id];

    if (!capHex) {
      statNoCap++;
      log('DEBUG', '[排除] ' + it.id + ' | 无 Capabilities 值 | cls=' + cls + ' | ' + online + ' | ' + name);
      continue;
    }
    const cap = parseInt(capHex[1], 16);
    const bits = capBits(cap);
    if (!isProtected && !shouldList(cap)) {
      statExcluded++;
      /* 把"为什么被排除"讲清楚,便于随时核对系统托盘 */
      const why = (cap & SURPRISE_BIT)
        ? '有 SURPRISE_REMOVAL_OK 位(系统视为可意外拔出,不进托盘)'
        : '当前为「' + MODE_LABEL[mode] + '」强度,该设备不满足显示条件';
      log('DEBUG', '[排除] ' + it.id + ' | cls=' + cls + ' | cap=' + bits + ' | ' + online + ' | ' + why + ' | ' + name);
      continue;
    }
    candidates.push({ id: it.id, name, cls, cap, online: online === '在线' || online === '未知' });
    log('INFO', '[候选] ' + it.id + ' | cls=' + cls + ' | cap=' + bits + ' | ' + online +
        (isProtected ? ' | 守护中' : '') + ' | ' + name);
  }
  log('INFO', '判定汇总:当前排除强度「' + MODE_LABEL[mode] + '」| 候选 ' + candidates.length +
      ' 台 | 排除:无Capabilities ' + statNoCap + ' / 不满足显示条件 ' + statExcluded);

  let rows = [];
  for (const c of candidates) {
    const isStorageParent = c.id.indexOf('USB\\') === 0 && storagePrefixes.has(serialOf(c.id).toUpperCase());
    const kind = isStorageParent ? 'usb' : inferKind(c.id, c.name, c.cls);
    const rec = state.protected[c.id];
    rows.push({
      id: c.id, name: c.name, kind, tag: KIND_TAG[kind] || '设备', cls: c.cls,
      capOriginal: rec ? rec.original : c.cap, capNow: c.cap, protected: !!rec, online: c.online,
    });
  }
  // 在线过滤:presentIds 可用时只留在线设备(守护对象始终保留,便于用户解除)
  let out;
  if (presentIds === null) {
    log('WARN', '在线状态检测不可用,显示全部候选设备');
    out = rows.map(function (r) { r.online = true; return r; });
  } else {
    out = rows
      .filter(function (r) { return r.protected || presentIds.has(r.id.toUpperCase()); })
      .map(function (r) { r.online = true; return r; });
  }
  if (instances.length === 0) {
    log('ERROR', '注册表枚举结果为 0——reg query 执行失败(被安全软件拦截或权限不足)。' +
      '这不是"没有设备",而是根本没读到数据!请检查杀软/权限后重试,并把日志发回。');
  } else if (out.length === 0 && Object.keys(state.protected).length === 0) {
    log('INFO', '说明:成功枚举 ' + instances.length + ' 个实例,当前排除强度「' + MODE_LABEL[mode] +
      '」下没有在线设备通过筛选。若你确知系统托盘里有设备,请把排除强度切到「关闭排除」再刷新;' +
      '这会把全部在线 USB 设备列出,供你人工挑选。');
  }
  // 已守护但当前不在线的设备(换口/拔出)也要显示,便于用户处理
  for (const id of Object.keys(state.protected)) {
    if (!out.find(x => x.id === id)) {
      const rec = state.protected[id];
      out.push({
        id, name: id, kind: rec.kind || 'periph', tag: '不在线',
        cls: '', capOriginal: rec.original, capNow: null,
        protected: true, online: false,
      });
    }
  }
  log('INFO', '最终显示 ' + out.length + ' 个设备');
  log('INFO', '========== 设备枚举明细结束 ==========');
  return out;
}

/* ============ 守护 / 解除 ============ */
/* 为指定能力值选择守护手法与目标值:
   - 带 REMOVABLE 位 → 清除该位(原值-4),即博客方法,让设备不再被视作"可移除"
   - 不带 REMOVABLE 位 → 置上 SURPRISE_REMOVAL_OK 位(原值+0x80),让系统认为可意外拔出、无需安全删除
   返回 null 表示无法安全处理(避免写出负数或越界值)。 */
function planMethod(cap) {
  if ((cap & REMOVABLE_BIT) !== 0) {
    const next = cap - REMOVABLE_BIT;
    if (next < 0) return null;
    return { method: METHOD_CLEAR_REMOVABLE, newVal: next };
  }
  if ((cap & SURPRISE_BIT) === 0) {
    const next = cap + SURPRISE_BIT;
    if (next > 0xFFFFFFFF) return null;
    return { method: METHOD_MARK_SURPRISE, newVal: next };
  }
  return null;
}

const METHOD_DESC = {
  'clear-removable': '清除 REMOVABLE 位(博客方法)',
  'mark-surprise': '标记为可意外拔出(应对无 REMOVABLE 位的设备)',
};

/* SurpriseRemovalOK 读写/还原(位于实例键的 Device Parameters 子键,reg export 备份已含该子树)。
   依据:该值决定设备能否不经「安全删除硬件」直接拔出;置 1 后系统不再要求安全删除,
   与 Capabilities 的 SURPRISE_REMOVAL_OK 位配合,双保险。
   注意:解除守护时必须把它还原成原样,否则设备会残留"可意外拔出"标记。 */
const surpriseWarned = new Set();
function surpriseKeyOf(instanceId) { return ENUM_ROOT + '\\' + instanceId + '\\Device Parameters'; }

async function readSurpriseRemovalOK(instanceId) {
  const cur = await regQueryValue(surpriseKeyOf(instanceId), 'SurpriseRemovalOK');
  if (!cur.ok) return { existed: false, value: 0 };
  const m = cur.stdout.match(/SurpriseRemovalOK\s+REG_DWORD\s+0x([0-9a-fA-F]+)/i);
  if (!m) return { existed: false, value: 0 };
  return { existed: true, value: parseInt(m[1], 16) };
}

async function ensureSurpriseRemovalOK(instanceId) {
  const cur = await readSurpriseRemovalOK(instanceId);
  if (cur.existed && cur.value === 1) return { ok: true, already: true };
  const w = await run('reg', ['add', surpriseKeyOf(instanceId), '/v', 'SurpriseRemovalOK', '/t', 'REG_DWORD', '/d', '1', '/f']);
  return { ok: w.ok, already: false, err: (w.stderr || '').trim() };
}

async function restoreSurpriseRemovalOK(instanceId, orig) {
  // 原本不存在 → 删除该值;原本存在 → 还原原值
  if (!orig || !orig.existed) {
    const d = await run('reg', ['delete', surpriseKeyOf(instanceId), '/v', 'SurpriseRemovalOK', '/f']);
    // 值本就不存在时 reg delete 会报错,视为成功
    return { ok: true, removed: true, note: d.ok ? '已删除' : '原本就不存在' };
  }
  const w = await run('reg', ['add', surpriseKeyOf(instanceId), '/v', 'SurpriseRemovalOK', '/t', 'REG_DWORD', '/d', String(orig.value || 0), '/f']);
  return { ok: w.ok, removed: false, err: (w.stderr || '').trim() };
}

async function protectDevice(instanceId) {
  if (!INSTANCE_ID_RE.test(instanceId)) {
    log('ERROR', '守护失败[ID非法] 请求值=' + JSON.stringify(String(instanceId)) +
        ' | 期望格式 USB\\VID_xxxx&PID_xxxx\\... 或 USBSTOR\\...');
    return { ok: false, error: '非法的设备实例 ID' };
  }
  if (state.protected[instanceId]) {
    log('WARN', '守护失败[已在守护中] ' + instanceId + ' | 原记录=' + JSON.stringify(state.protected[instanceId]));
    return { ok: false, error: '该设备已在守护中' };
  }
  if (!state.isAdmin) {
    log('ERROR', '守护失败[权限不足] ' + instanceId + ' | 当前为只读模式,进程未以管理员/SYSTEM 运行');
    return { ok: false, error: '需要管理员权限(请以管理员运行)' };
  }

  const cap = await getCapabilities(instanceId);
  if (cap === null) {
    log('ERROR', '守护失败[读取原值失败] ' + instanceId +
        ' | reg query Capabilities 无结果:设备可能已拔出,或该键被安全软件拦截读取');
    return { ok: false, error: '读取 Capabilities 失败(设备可能已拔出)' };
  }
  const plan = planMethod(cap);
  if (!plan) {
    log('ERROR', '守护失败[无可用手法] ' + instanceId + ' | cap=' + capBits(cap) +
        ' | 无 REMOVABLE 位可清,且 SURPRISE_REMOVAL_OK 已置位(系统本就无需安全删除)');
    return {
      ok: false,
      error: '该设备的能力位无法安全修改(缺少 REMOVABLE 位,且已标记为可意外拔出)。' +
             '系统不会把它列进「安全删除硬件」,无需守护。',
    };
  }
  const newVal = plan.newVal;
  log('INFO', '守护方案:' + METHOD_DESC[plan.method] + ' | ' + capBits(cap) + ' → ' + capBits(newVal));

  // 1. 备份原键
  const safe = instanceId.replace(/[^A-Za-z0-9.-]/g, '_');
  const backupFile = path.join(BACKUP_DIR, safe + '.reg');
  const exp = await run('reg', ['export', ENUM_ROOT + '\\' + instanceId, backupFile, '/y']);
  if (!exp.ok) {
    log('ERROR', '守护失败[备份注册表失败] ' + instanceId + ' | 命令:reg export | 输出:' +
        ((exp.stderr || exp.stdout || '').trim() || '(无)') + ' | 未做任何修改,系统保持原状');
    return { ok: false, error: '备份注册表失败:' + (exp.stderr || '').trim() };
  }

  // 2. 写入新值
  const add = await run('reg', ['add', ENUM_ROOT + '\\' + instanceId, '/v', 'Capabilities', '/t', 'REG_DWORD', '/d', String(newVal), '/f']);
  if (!add.ok) {
    log('ERROR', '守护失败[写入注册表失败] ' + instanceId + ' | 手法=' + plan.method +
        ' | 目标值=' + newVal + '(' + capBits(newVal) + ') | 输出:' +
        ((add.stderr || add.stdout || '').trim() || '(无)') +
        ' | 备份已在:' + backupFile + '(可随时解除守护还原)');
    return { ok: false, error: '写入注册表失败:' + (add.stderr || '').trim() + '(若为拒绝访问,请用计划任务的 SYSTEM 服务运行)' };
  }

  // 3. 回读验证
  const verify = await getCapabilities(instanceId);
  if (verify !== newVal) {
    const rb = await run('reg', ['add', ENUM_ROOT + '\\' + instanceId, '/v', 'Capabilities', '/t', 'REG_DWORD', '/d', String(cap), '/f']);
    log('ERROR', '守护失败[写入后验证不符] ' + instanceId + ' | 期望=' + newVal + '(' + capBits(newVal) +
        ') 实际读回=' + verify + ' | 已' + (rb.ok ? '成功' : '尝试') + '回滚为原值 ' + capBits(cap) +
        ' | 备份:' + backupFile);
    return { ok: false, error: '写入后验证失败(读回 ' + verify + ',期望 ' + newVal + '),已' + (rb.ok ? '回滚原值' : '尝试回滚') + '。备份:' + backupFile };
  }

  // 4. 博客步骤1:对无线网卡写入 SelectiveSuspendEnabled=0(禁用 USB 选择性暂停,防省电掉线)
  const devName = await getDeviceName(instanceId);
  if (/wireless|wi-?fi|wlan|802\.11|无线/i.test(devName)) {
    const ss = await run('reg', ['add', ENUM_ROOT + '\\' + instanceId + '\\Device Parameters', '/v', 'SelectiveSuspendEnabled', '/t', 'REG_DWORD', '/d', '0', '/f']);
    if (ss.ok) log('INFO', '已写入 SelectiveSuspendEnabled=0(禁用 USB 选择性暂停,防省电掉线):' + devName);
    else log('WARN', '写入 SelectiveSuspendEnabled 失败(不影响守护本身):' + (ss.stderr || '').trim());
  }

  // 4.5 mark-surprise 手法:先记录原值(解除时还原),再置 SurpriseRemovalOK=1(双保险)
  let surpriseOrig = null;
  if (plan.method === METHOD_MARK_SURPRISE) {
    surpriseOrig = await readSurpriseRemovalOK(instanceId);
    const sr = await ensureSurpriseRemovalOK(instanceId);
    if (sr.ok) log('INFO', '已设置 SurpriseRemovalOK=1(设备可意外拔出,系统不再要求安全删除)' +
      (sr.already ? ',原本已是' : '') + ' | 原状态:' + (surpriseOrig.existed ? ('=' + surpriseOrig.value) : '不存在'));
    else log('WARN', '设置 SurpriseRemovalOK 失败(主手法仍为 Capabilities 位,可继续观察托盘):' + sr.err);
  }

  // 5. 记录守护(正确判断存储类:USBSTOR 或"序列号在存储子设备 ParentIdPrefix 中"的 USB 父设备)
  let kind = instanceId.startsWith('USBSTOR\\') ? 'usb' : 'periph';
  let storage = instanceId.startsWith('USBSTOR\\');
  if (!storage) {
    const prefixes = await collectStoragePrefixes();
    storage = prefixes.has(serialOf(instanceId).toUpperCase());
    if (storage) kind = 'usb';
  }
  state.protected[instanceId] = {
    original: cap,
    method: plan.method,          // 守护循环按同一手法重打
    surpriseOrig,                 // mark-surprise 手法专用:解除时还原 SurpriseRemovalOK
    hwidPrefix: instanceId.split('\\').slice(0, 2).join('\\'),
    storage,
    kind,
    addedAt: new Date().toISOString(),
    backupFile,
  };
  if (!state.engine) state.engine = true;
  saveConfig();
  log('OK', '守护成功 ' + instanceId + ' [' + METHOD_DESC[plan.method] + ']:Capabilities ' +
      capBits(cap) + ' → ' + capBits(newVal) + '(备份:' + backupFile + ')');

  // 6. 存储类警示:U盘/移动硬盘的可弹出项来自媒体层,改设备节点能力位通常无效(实测确认)
  let warning = '';
  if (storage) {
    warning = 'U盘/移动硬盘的「可弹出」来自存储媒体层,本方法通常无法把它从托盘移除。' +
              '建议把守护对象放在网卡 / 集线器这类单一 USB 设备上。';
    log('WARN', '警示:该设备属存储类,' + warning);
  }
  log('INFO', '提示:若「安全删除硬件」里仍能看到该设备,请点该设备的「使生效」重启设备,' +
      '或用日志卡右上角的「刷新托盘」重启资源管理器强制重新枚举。');

  // 7. 复合设备提示:同一物理设备(相同硬件 ID 前缀)可能还有其它"需安全删除"的节点未守护。
  //    例如 USB Billboard / 多接口无线网卡,只守护其中一个节点时,系统托盘条目可能仍然存在。
  const leftover = await findSameDeviceUnprotected(instanceId);
  if (leftover.length) {
    log('WARN', '注意:同一物理设备还有 ' + leftover.length + ' 个节点未守护,若托盘里仍看得到该设备,请把下列节点也一并「守护」:');
    for (const it of leftover) log('WARN', '  · ' + it.id + ' | cap=' + capBits(it.cap) + ' | ' + it.name);
  }

  // 8. 自动使变更生效:重启该设备,令系统重新读取 Capabilities(注册表改了不代表设备已采用)
  let applied = null;
  if (state.autoApply) {
    state.protected[instanceId].lastRestartAt = Date.now();
    saveConfig();
    applied = await restartDevice(instanceId);
    if (!applied.ok) log('WARN', '自动重启设备未成功,变更可能需手动点「使生效」或重启电脑:' + (applied.error || ''));
  } else {
    log('INFO', '未开启自动生效,如托盘里仍在,请点该设备的「使生效」');
  }

  return { ok: true, capOriginal: cap, capNow: newVal, method: plan.method, leftover, warning, applied };
}

/* 找出与指定实例属于同一物理设备(硬件 ID 前缀相同)、且当前仍"需安全删除"(无 SURPRISE 位)的其它节点。
   仅用于守护成功后的提示,不做任何自动写入——避免替用户做决定。 */
async function findSameDeviceUnprotected(instanceId) {
  const prefix = instanceId.split('\\').slice(0, 2).join('\\');
  const out = [];
  try {
    const instances = await enumRegInstances();
    for (const it of instances) {
      if (it.id === instanceId) continue;
      if (!it.id.startsWith(prefix + '\\')) continue;
      if (state.protected[it.id]) continue;
      const capHex = String(it.vals.Capabilities || '').match(/0x([0-9a-fA-F]+)/);
      if (!capHex) continue;
      const cv = parseInt(capHex[1], 16);
      if ((cv & SURPRISE_BIT) !== 0) continue;   // 已无需安全删除的节点不算
      out.push({ id: it.id, cap: cv, name: cleanName(it.vals.FriendlyName || it.vals.DeviceDesc || it.id) });
    }
  } catch (e) { /* 提示性功能,失败不影响守护结果 */ }
  return out;
}

async function unprotectDevice(instanceId) {
  const rec = state.protected[instanceId];
  if (!rec) {
    log('WARN', '解除失败[不在守护清单] ' + instanceId);
    return { ok: false, error: '该设备不在守护中' };
  }
  if (!state.isAdmin) {
    log('ERROR', '解除失败[权限不足] ' + instanceId + ' | 只读模式无法还原注册表');
    return { ok: false, error: '需要管理员权限(请以管理员运行)' };
  }

  // 先移清单再还原,避免守护循环竞态回写
  // 注意:只移除设备,绝不动守护引擎开关——引擎是用户的显式选择,
  // 解除最后一台设备时自动关引擎会让用户莫名其妙(旧版的错误行为)。
  delete state.protected[instanceId];
  saveConfig();

  const cap = await getCapabilities(instanceId);
  if (cap === null) {
    log('WARN', '解除守护 ' + instanceId + ':设备当前不在线,值将由系统自然还原(原值记录=' + rec.original + ')');
    return { ok: true, note: '设备不在线,系统重新枚举时会自动使用原值' };
  }
  const add = await run('reg', ['add', ENUM_ROOT + '\\' + instanceId, '/v', 'Capabilities', '/t', 'REG_DWORD', '/d', String(rec.original), '/f']);
  if (!add.ok) {
    // 还原失败要回滚清单,保持守护
    state.protected[instanceId] = rec;
    saveConfig();
    log('ERROR', '解除失败[还原注册表失败] ' + instanceId + ' | 目标原值=' + rec.original +
        ' | 输出:' + ((add.stderr || add.stdout || '').trim() || '(无)') + ' | 已恢复守护清单,设备仍在守护中');
    return { ok: false, error: '还原注册表失败:' + (add.stderr || '').trim() };
  }
  const verify = await getCapabilities(instanceId);
  log('OK', '解除守护 ' + instanceId + ':Capabilities 还原为 ' + rec.original + '(' + capBits(rec.original) + ') 验证读回=' + verify);

  // mark-surprise 手法:一并还原 SurpriseRemovalOK,避免残留"可意外拔出"标记
  if ((rec.method || METHOD_CLEAR_REMOVABLE) === METHOD_MARK_SURPRISE) {
    const rs = await restoreSurpriseRemovalOK(instanceId, rec.surpriseOrig);
    if (rs.ok) log('INFO', '解除守护:' + instanceId + ' 的 SurpriseRemovalOK ' + (rs.removed ? '已删除' : '已还原为原值') +
      (rs.note ? '(' + rs.note + ')' : ''));
    else log('WARN', '解除守护:SurpriseRemovalOK 还原失败(不影响功能,可手动清理):' + rs.err);
  }
  return { ok: true };
}

/* ============ 守护循环 ============ */
async function guardOnce() {
  if (!state.engine) return;
  for (const instanceId of Object.keys(state.protected)) {
    const rec = state.protected[instanceId];
    const cap = await getCapabilities(instanceId);
    // 按守护时记录的手法重算目标值:无 method 的旧记录按 clear-removable 兼容
    const method = rec.method || METHOD_CLEAR_REMOVABLE;
    const want = method === METHOD_MARK_SURPRISE ? rec.original + SURPRISE_BIT : rec.original - REMOVABLE_BIT;

    if (cap === null) {
      // 刚重启过设备(自动/手动"使生效")会出现短暂离线,给 60 秒宽限期,避免误判为换口而迁移守护
      if (rec.lastRestartAt && (Date.now() - rec.lastRestartAt) < 60000) continue;
      // 键不存在:设备离线。内置设备尝试按 VID&PID 重匹配(存储设备不自动,防误伤同型号他人U盘)
      if (!rec.storage) await tryRematch(instanceId, rec);
      continue;
    }

    // mark-surprise 手法:每轮顺带维护 SurpriseRemovalOK=1(在能力值比对之前,独立校验)
    if (method === METHOD_MARK_SURPRISE) {
      const sr = await ensureSurpriseRemovalOK(instanceId);
      if (!sr.ok && !surpriseWarned.has(instanceId)) {
        surpriseWarned.add(instanceId);
        log('WARN', '自动维护 SurpriseRemovalOK 失败(不影响 Capabilities 守护):' + sr.err);
      } else if (sr.ok && !sr.already) {
        log('WARN', '检测到 SurpriseRemovalOK 被写回,已重新置为 1:' + instanceId);
      }
    }

    if (cap === want) continue;

    // 被系统写回,重新打上
    const add = await run('reg', ['add', ENUM_ROOT + '\\' + instanceId, '/v', 'Capabilities', '/t', 'REG_DWORD', '/d', String(want), '/f']);
    if (add.ok) {
      state.autoFixCount++;
      saveConfig();
      log('WARN', '检测到 ' + instanceId + ' 的 Capabilities 被系统写回为 ' + capBits(cap) +
          ',已自动修复为 ' + capBits(want) + '(累计 ' + state.autoFixCount + ' 次)');
    } else {
      log('ERROR', '自动修复 ' + instanceId + ' 失败:' + (add.stderr || '').trim());
    }
  }
}

/* 内置设备换口:按硬件 ID 前缀在新实例上重新守护 */
async function tryRematch(oldId, rec) {
  const instances = await enumRegInstances();
  let cand = null, candCap = 0;
  for (const it of instances) {
    if (it.id === oldId) continue;
    if (!it.id.startsWith(rec.hwidPrefix)) continue;
    const capHex = String(it.vals.Capabilities || '').match(/0x([0-9a-fA-F]+)/);
    if (!capHex) continue;
    const cv = parseInt(capHex[1], 16);
    if (!planMethod(cv)) continue;      // 新实例无法安全处理则跳过
    cand = it.id; candCap = cv;
    break;
  }
  if (!cand) return;
  const cap = await getCapabilities(cand);
  if (cap === null) return;
  const plan = planMethod(cap);
  if (!plan) return;
  const add = await run('reg', ['add', ENUM_ROOT + '\\' + cand, '/v', 'Capabilities', '/t', 'REG_DWORD', '/d', String(plan.newVal), '/f']);
  if (!add.ok) return;
  // 迁移到新实例:SurpriseRemovalOK 的原状态需按新实例重新记录
  let newSurpriseOrig = rec.surpriseOrig || null;
  if (plan.method === METHOD_MARK_SURPRISE) {
    newSurpriseOrig = await readSurpriseRemovalOK(cand);
    await ensureSurpriseRemovalOK(cand);
  }
  delete state.protected[oldId];
  state.protected[cand] = Object.assign({}, rec, {
    original: cap, method: plan.method, surpriseOrig: newSurpriseOrig, addedAt: new Date().toISOString(),
  });
  saveConfig();
  log('WARN', '设备换口:自动把守护从 ' + oldId + ' 迁移到 ' + cand + '[原值 ' + capBits(cap) + ' → ' + capBits(plan.newVal) + ']');
}

/* ============ 使变更立即生效 ============ */
/* 重启单个设备:让系统重新读取该设备的 Capabilities(比重启资源管理器更精准、副作用小)。
   首选 pnputil /restart-device(Win10 2004+);失败则回退"禁用→启用"。 */
async function restartDevice(instanceId) {
  if (!INSTANCE_ID_RE.test(instanceId)) {
    log('ERROR', '重启设备失败[ID非法] ' + JSON.stringify(String(instanceId)));
    return { ok: false, error: '非法的设备实例 ID' };
  }
  if (!state.isAdmin) {
    log('ERROR', '重启设备失败[权限不足] ' + instanceId);
    return { ok: false, error: '需要管理员权限' };
  }
  log('INFO', '重启设备(使注册表变更立即生效):' + instanceId);
  const r = await run('pnputil', ['/restart-device', instanceId]);
  if (r.ok) {
    log('OK', '设备已重启:' + instanceId);
    return { ok: true, method: 'pnputil /restart-device' };
  }
  log('WARN', 'pnputil /restart-device 失败,尝试禁用+启用:' + ((r.stderr || r.stdout || '').trim() || '(无输出)'));
  const d = await run('pnputil', ['/disable-device', instanceId]);
  if (!d.ok) {
    log('ERROR', '禁用设备失败:' + ((d.stderr || d.stdout || '').trim() || '(无输出)'));
    return { ok: false, error: '重启设备失败:' + ((d.stderr || d.stdout || '').trim() || '未知错误') };
  }
  const e = await run('pnputil', ['/enable-device', instanceId]);
  if (!e.ok) {
    log('ERROR', '启用设备失败(设备当前可能处于禁用状态,请到设备管理器手动启用):' + ((e.stderr || e.stdout || '').trim() || '(无输出)'));
    return { ok: false, error: '设备已禁用但启用失败,请到设备管理器手动启用' };
  }
  log('OK', '设备已通过 禁用+启用 重启:' + instanceId);
  return { ok: true, method: 'pnputil /disable-device + /enable-device' };
}

/* 重启资源管理器:强制系统托盘(含「安全删除硬件」)重建。
   注意:任务栏会闪一下,属预期现象;仅作为最后的兜底手段。 */
async function restartTray() {
  if (!state.isAdmin) {
    log('ERROR', '刷新托盘失败[权限不足]');
    return { ok: false, error: '需要管理员权限' };
  }
  log('WARN', '用户操作:重启资源管理器以刷新系统托盘(任务栏将短暂闪烁)');
  const k = await run('taskkill', ['/f', '/im', 'explorer.exe']);
  if (!k.ok) {
    log('WARN', '结束 explorer.exe 失败(可能未在运行):' + ((k.stderr || k.stdout || '').trim() || '(无输出)'));
  }
  await new Promise(function (r) { setTimeout(r, 800); });
  const s = await run('cmd', ['/c', 'start', '', 'explorer.exe']);
  if (s.ok) {
    log('OK', '资源管理器已重启,系统托盘已重建');
    return { ok: true };
  }
  log('ERROR', '重启资源管理器失败:' + ((s.stderr || s.stdout || '').trim() || '(无输出)') +
      ' | 可手动按 Ctrl+Shift+Esc 打开任务管理器→文件→运行新任务→explorer.exe');
  return { ok: false, error: '重启资源管理器失败,请手动运行 explorer.exe' };
}

/* ============ 计划任务(开机自启) ============ */
async function setBoot(enabled) {
  if (!state.isAdmin) return { ok: false, error: '需要管理员权限' };
  const nodeExe = path.join(APP_DIR, 'node.exe');
  const serverJs = path.join(APP_DIR, 'server.js');
  const trayExe = path.join(APP_DIR, 'DeviceKeeper.exe');

  if (enabled) {
    // 服务任务:SYSTEM 最高权限,开机即守护(无头,不弹任何窗口)
    const svc = await run('schtasks', ['/Create', '/TN', TASK_SERVICE,
      '/TR', '"' + nodeExe + '" "' + serverJs + '"',
      '/SC', 'ONSTART', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/F']);
    if (!svc.ok) return { ok: false, error: '注册服务任务失败:' + (svc.stderr || '').trim() };
    // 托盘任务:当前用户登录时显示托盘(交互);若 exe 不存在仅提示,不影响守护
    if (!fs.existsSync(trayExe)) {
      log('WARN', '未找到 ' + trayExe + ',仅注册服务任务;请先用 编译程序.bat 生成主程序');
    }
    const tray = fs.existsSync(trayExe)
      ? await run('schtasks', ['/Create', '/TN', TASK_TRAY, '/TR', '"' + trayExe + '"', '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/IT', '/F'])
      : { ok: false };
    state.boot = true;
    log('OK', '已注册开机自启(ONSTART 服务 + ONLOGON 托盘' + (tray.ok ? '' : ',托盘任务失败:' + (tray.stderr || '').trim()) + ')');
    return { ok: true };
  }
  const r1 = await run('schtasks', ['/Delete', '/TN', TASK_SERVICE, '/F']);
  const r2 = await run('schtasks', ['/Delete', '/TN', TASK_TRAY, '/F']);
  state.boot = false;
  log('WARN', '已取消开机自启(服务:' + r1.ok + ',托盘:' + r2.ok + ')');
  return { ok: true };
}

async function queryBoot() {
  const r = await run('schtasks', ['/Query', '/TN', TASK_SERVICE]);
  return r.ok;
}

/* ============ HTTP 服务 ============ */
let TOKEN = '';

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 65536) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); }
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

function serveStatic(req, res, urlObj) {
  let p = decodeURIComponent(urlObj.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

/* 生成完整诊断报告文本(系统信息 + 守护配置 + 设备枚举 + 最近日志),供导出反馈 */
function buildDiagnosticReport(devices) {
  const L = [];
  const time = new Date().toLocaleString('zh-CN', { hour12: false });
  L.push('==== DeviceKeeper 诊断报告 ====');
  L.push('生成时间: ' + time);
  L.push('');
  L.push('[运行环境]');
  L.push('Node: ' + process.version + '  平台: ' + process.platform + '/' + process.arch);
  L.push('程序目录: ' + APP_DIR);
  L.push('数据目录: ' + DATA_DIR);
  L.push('权限: ' + (state.isAdmin ? '管理员(可读写)' : '标准用户(只读)'));
  L.push('守护引擎: ' + (state.engine ? '开' : '关') + '   开机自启: ' + (state.boot ? '开' : '关'));
  L.push('累计自动修复: ' + state.autoFixCount + ' 次');
  L.push('排除强度: ' + ({ strict: '严格', relaxed: '宽松', off: '关闭排除' }[state.excludeMode] || state.excludeMode));
  L.push('会话日志文件: ' + state.sessionLogFile);
  L.push('');
  L.push('[守护对象] 共 ' + Object.keys(state.protected).length + ' 台');
  for (const id of Object.keys(state.protected)) {
    const r = state.protected[id];
    L.push('  - ' + id);
    L.push('    原值=' + r.original + '(' + capBits(r.original) + ')  手法=' + (r.method || METHOD_CLEAR_REMOVABLE) +
      '  存储类=' + (r.storage ? '是' : '否') + '  守护时间=' + r.addedAt);
    if ((r.method || '') === METHOD_MARK_SURPRISE) {
      L.push('    SurpriseRemovalOK 原状态=' + (r.surpriseOrig ? (r.surpriseOrig.existed ? ('存在,值=' + r.surpriseOrig.value) : '原本不存在') : '未记录(旧版本记录)'));
    }
    L.push('    备份=' + r.backupFile);
  }
  L.push('');
  L.push('[当前可弹出设备] 共 ' + devices.length + ' 台');
  for (const d of devices) {
    L.push('  - ' + d.name + '  [' + d.kind + '/' + d.tag + ']');
    L.push('    ID: ' + d.id);
    L.push('    cls=' + d.cls + '  cap当前=' + (d.capNow === null ? '不在线' : capBits(d.capNow)) + '  cap原值=' + (d.capOriginal === null ? '-' : capBits(d.capOriginal)) + '  守护=' + (d.protected ? '是' : '否') + '  在线=' + (d.online ? '是' : '否'));
  }
  L.push('');
  L.push('[最近日志]');
  for (const l of state.logMem.slice(-120)) {
    L.push('  ' + l.time + '  [' + l.level + '] ' + l.msg);
  }
  return L.join('\r\n');
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, 'http://127.0.0.1');
  // DNS rebinding 防护:Host 必须是本机回环
  const host = String(req.headers.host || '');
  if (host !== '127.0.0.1:' + PORT && host !== 'localhost:' + PORT) {
    return json(res, 403, { ok: false, error: 'Forbidden Host' });
  }

  if (urlObj.pathname === '/api/ping') {
    return json(res, 200, { app: 'DeviceKeeper', engine: state.engine });
  }
  if (urlObj.pathname.startsWith('/api/')) {
    if (!checkToken(req, urlObj)) return json(res, 401, { ok: false, error: '无效令牌' });
    try {
      switch (urlObj.pathname) {
        case '/api/state': {
          return json(res, 200, {
            ok: true, isAdmin: state.isAdmin, engine: state.engine,
            autoFixCount: state.autoFixCount,
            protectedCount: Object.keys(state.protected).length,
            boot: state.boot, startedAt: state.startedAt,
            excludeMode: state.excludeMode, autoApply: state.autoApply,
          });
        }
        case '/api/devices':
          return json(res, 200, { ok: true, excludeMode: state.excludeMode, devices: await listDevices() });
        case '/api/mode': {
          const body = await readBody(req);
          const m = String(body.mode || '');
          if (EXCLUDE_MODES.indexOf(m) < 0) return json(res, 400, { ok: false, error: '无效的排除强度' });
          state.excludeMode = m;
          saveConfig();
          log('INFO', '排除强度已切换为「' + ({ strict: '严格', relaxed: '宽松', off: '关闭排除' }[m]) + '」');
          return json(res, 200, { ok: true, excludeMode: m, devices: await listDevices() });
        }
        case '/api/restart-device': {
          const body = await readBody(req);
          const id = String(body.id || '');
          const r = await restartDevice(id);
          if (r.ok && state.protected[id]) {   // 记录重启时间,守护循环给宽限期
            state.protected[id].lastRestartAt = Date.now();
            saveConfig();
          }
          return json(res, r.ok ? 200 : 400, r);
        }
        case '/api/autoapply': {
          const body = await readBody(req);
          state.autoApply = !!body.on;
          saveConfig();
          log('INFO', '守护后自动重启设备:' + (state.autoApply ? '已开启' : '已关闭'));
          return json(res, 200, { ok: true, autoApply: state.autoApply });
        }
        case '/api/restart-tray': {
          const r = await restartTray();
          return json(res, r.ok ? 200 : 400, r);
        }
        case '/api/protect': {
          const body = await readBody(req);
          const r = await protectDevice(String(body.id || ''));
          if (r.ok) log('INFO', '用户操作:守护 ' + body.id + ' → 成功(手法 ' + (r.method || '') + ')');
          else log('WARN', '用户操作:守护 ' + body.id + ' → 失败:' + r.error);
          return json(res, r.ok ? 200 : 400, r);
        }
        case '/api/unprotect': {
          const body = await readBody(req);
          const r = await unprotectDevice(String(body.id || ''));
          if (r.ok) log('INFO', '用户操作:解除守护 ' + body.id + ' → 成功');
          else log('WARN', '用户操作:解除守护 ' + body.id + ' → 失败:' + r.error);
          return json(res, r.ok ? 200 : 400, r);
        }
        case '/api/engine': {
          const body = await readBody(req);
          state.engine = !!body.on;
          saveConfig();
          log('INFO', '守护引擎已' + (state.engine ? '开启' : '停止'));
          return json(res, 200, { ok: true, engine: state.engine });
        }
        case '/api/boot': {
          const body = await readBody(req);
          const r = await setBoot(!!body.on);
          return json(res, r.ok ? 200 : 400, r);
        }
        case '/api/logs':
          return json(res, 200, { ok: true, logs: state.logMem.slice(-100) });
        case '/api/logs/clear':
          state.logMem = [];
          return json(res, 200, { ok: true });
        case '/api/export-log': {
          const devices = await listDevices().catch(() => []);
          const text = buildDiagnosticReport(devices);
          return json(res, 200, { ok: true, text, fileName: 'DeviceKeeper诊断-' + nowStamp() + '.txt', sessionLogFile: state.sessionLogFile });
        }
        default:
          return json(res, 404, { ok: false, error: 'Unknown API' });
      }
    } catch (e) {
      log('ERROR', 'API 异常 ' + urlObj.pathname + ':' + e.message);
      return json(res, 500, { ok: false, error: '服务器内部错误:' + e.message });
    }
  }
  serveStatic(req, res, urlObj);
});

/* ============ 启动 ============ */
async function main() {
  ensureDirs();
  loadConfig();
  TOKEN = ensureToken();
  state.sessionLogFile = path.join(DATA_DIR, 'logs', 'devicekeeper-' + nowStamp() + '.log');

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log('ERROR', '端口 ' + PORT + ' 已被占用,请检查是否已有 DeviceKeeper 实例在运行');
      process.exit(2);
    }
    log('ERROR', 'HTTP 服务错误:' + e.message);
  });

  server.listen(PORT, HOST, async () => {
    log('INFO', '===== DeviceKeeper 会话启动 =====');
    log('INFO', '时间:' + new Date().toLocaleString('zh-CN', { hour12: false }));
    log('INFO', 'Node:' + process.version + '  平台:' + process.platform + '/' + process.arch);
    log('INFO', '程序目录:' + APP_DIR);
    log('INFO', '数据目录:' + DATA_DIR);
    log('INFO', '会话日志:' + state.sessionLogFile);
    log('INFO', '服务已启动:http://' + HOST + ':' + PORT);
    log('INFO', '守护引擎:' + (state.engine ? '开' : '关') + '  守护设备:' + Object.keys(state.protected).length + ' 台  累计修复:' + state.autoFixCount + ' 次');
    await detectAdmin();
    state.boot = await queryBoot();
    log('INFO', '开机自启:' + (state.boot ? '已开启(ONSTART 服务 + ONLOGON 托盘)' : '未开启'));
    setInterval(guardOnce, GUARD_INTERVAL_MS);
    guardOnce(); // 启动即执行一次守护,不等第一个周期
  });
}

main();
