// RICH2 Run.exe 容量上限 patcher（可重複執行、自動備份）
//
// Run.exe 內有一段依地圖代號設定容量的初始化碼（0x1249e~0x124ec），每張圖寫死三個全域：
//   [0x1096] = 最大合法地點編號       台灣119 / 香港140 / 城282
//   [0x1098] = 特殊地點數（迭代/邊界用）台灣23  / 香港27  / 城40
//   [0x1058] = 玩家/角色數（UI排版用）  台灣4   / 香港5   / 城6
// 註：土地/特殊的實際分界是引擎寫死的「編號≤49＝特殊/非土地、≥50＝土地」，不是這三個值。
//
// 目前策略（依使用者指示）：
//   只放寬 [0x1096]（最大地點編號）到 282（= 大富翁城），讓三張圖都能擴充土地/道路到城的規模。
//   [0x1098]（特殊數）與 [0x1058]（玩家數）維持各圖原值，先不動。
//   （若日後要動特殊數/玩家數，用 --special / --players 旗標。）
//
// 用法:
//   node patch_runexe.mjs             顯示現值（不改）
//   node patch_runexe.mjs --apply     台灣/香港 maxLocId → 282（特殊數/玩家數不動）
//   node patch_runexe.mjs --apply --special   同時把台灣/香港特殊數 → 40（進階）
//   node patch_runexe.mjs --apply --players   同時把台灣/香港玩家數 → 6（進階）
//   node patch_runexe.mjs --restore   從 Run.exe.bak 還原
import fs from 'fs';

const EXE = new URL('./rich2/Run.exe', import.meta.url);
const BAK = new URL('./rich2/Run.exe.bak', import.meta.url);

const MAPS = {
    TW: { name: '台灣', maxLoc: 0x124aa, special: 0x124b0, players: 0x124b6 },
    HK: { name: '香港', maxLoc: 0x124c4, special: 0x124ca, players: 0x124d0 },
    RC: { name: '大富翁城', maxLoc: 0x124de, special: 0x124e4, players: 0x124ea },
};
const RC_MAXLOC = 282, RC_SPECIAL = 40, RC_PLAYERS = 6;

if (process.argv.includes('--restore')) {
    if (!fs.existsSync(BAK)) { console.error('找不到 rich2/Run.exe.bak，無法還原。'); process.exit(1); }
    fs.copyFileSync(BAK, EXE);
    console.log('✅ 已從 Run.exe.bak 還原 Run.exe。');
    process.exit(0);
}

const apply = process.argv.includes('--apply');
const doSpecial = process.argv.includes('--special');
const doPlayers = process.argv.includes('--players');
const buf = fs.readFileSync(EXE);
const rd = o => buf.readUInt16LE(o);

console.log('目前 Run.exe 容量設定：');
for (const m of Object.values(MAPS)) {
    console.log(`  ${m.name.padEnd(5)} maxLocId=${rd(m.maxLoc)}  特殊數=${rd(m.special)}  玩家數=${rd(m.players)}`);
}

// 目標：台灣/香港 maxLocId → 282；特殊數/玩家數僅在旗標開啟時才動
const targets = [];
for (const key of ['TW', 'HK']) {
    const m = MAPS[key];
    targets.push([m.maxLoc, RC_MAXLOC, `${m.name} maxLocId → ${RC_MAXLOC}`]);
    if (doSpecial) targets.push([m.special, RC_SPECIAL, `${m.name} 特殊數 → ${RC_SPECIAL}`]);
    if (doPlayers) targets.push([m.players, RC_PLAYERS, `${m.name} 玩家數 → ${RC_PLAYERS}`]);
}

console.log('\n將套用：');
for (const [off, val, label] of targets) {
    const cur = rd(off);
    console.log(`  @0x${off.toString(16)}: ${cur}${cur === val ? '（已是目標值）' : ' → ' + val}   (${label})`);
}
console.log(doSpecial ? '' : '  （特殊數 [0x1098] 維持原值，未動）');
console.log(doPlayers ? '' : '  （玩家數 [0x1058] 維持原值，未動）');

if (!apply) { console.log('\n（dry-run，加 --apply 才會寫入；首次寫入前會備份 rich2/Run.exe.bak）'); process.exit(0); }

if (!fs.existsSync(BAK)) { fs.copyFileSync(EXE, BAK); console.log('\n已備份原始檔 → rich2/Run.exe.bak'); }
else console.log('\n（Run.exe.bak 已存在，保留原始備份不覆蓋）');

for (const [off, val] of targets) buf.writeUInt16LE(val, off);
fs.writeFileSync(EXE, buf);
console.log('✅ 已套用。還原：node patch_runexe.mjs --restore');
