// 给爬虫用的输出工具
//
// 为什么要有这个档：
//   Node 的 process.stdout 接到「管道」时是缓冲的（只有 TTY 才即时），
//   所以 GUI 用 spawn 时会完全收不到进度，直到程序结束才一次吐出。
//   process.stderr 是同步、不缓冲的 → 进度一律写 stderr，GUI 就能即时收到。
//
//   同时仍写一份到 stdout，这样直接跑 CLI 的人（或重导向到档案）也看得到完整紀录。

export function out(line = '') {
  try {
    process.stdout.write(line + '\n');
  } catch {}
}

export function progress(payload) {
  try {
    process.stderr.write(`[PROGRESS] ${payload}\n`);
  } catch {}
}

export function note(line = '') {
  // 给人看的即时讯息：同时走 stderr（GUI 即时）与 stdout（档案紀录）
  try {
    process.stderr.write(line + '\n');
  } catch {}
  out(line);
}
