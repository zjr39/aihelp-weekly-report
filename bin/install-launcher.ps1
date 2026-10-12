# 客诉周报工具 - 桌面启动器安装脚本
#
# 用途：在桌面建立「客诉周报工具」与「结束客诉周报工具」两个捷径，
#       让你不用再进资料夹找启动程序。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File bin\install-launcher.ps1
#   powershell -ExecutionPolicy Bypass -File bin\install-launcher.ps1 -Remove
#   powershell -ExecutionPolicy Bypass -File bin\install-launcher.ps1 -ShowWindow
#
# -ShowWindow：改成产生指向「启动工具.cmd」的捷径（会显示黑色视窗，方便盯日志）
# -Remove    ：移除桌面捷径
#
# 可重复执行：每次都会覆盖旧捷径，所以专案搬家后重跑一次就能修复。
#
# 编码注意：本档为 UTF-8 with BOM。PowerShell 5.1 读 UTF-8 无 BOM 的中文会乱码，
#           所以不要存成无 BOM。

[CmdletBinding()]
param(
    [switch]$Remove,
    [switch]$ShowWindow
)

$ErrorActionPreference = 'Stop'

# ── 路径解析 ──
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root      = Split-Path -Parent $scriptDir

$launchVbs = Join-Path $scriptDir 'launch-hidden.vbs'
$stopVbs   = Join-Path $scriptDir 'stop-hidden.vbs'
$cmdFile   = Join-Path $root      'start.cmd'
$icon      = Join-Path $root      'assets\icon.ico'
$makeIcon  = Join-Path $root      'tools\make-icon.mjs'

$desktop   = [Environment]::GetFolderPath('Desktop')
$mainLnk   = Join-Path $desktop '客诉周报工具.lnk'
$stopLnk   = Join-Path $desktop '结束客诉周报工具.lnk'

$wscript   = Join-Path $env:WINDIR 'System32\wscript.exe'

function Write-Head($text) {
    Write-Host ''
    Write-Host "  $text" -ForegroundColor Cyan
}

Write-Head '客诉周报工具 - 桌面启动器安装'
Write-Host "  专案目录：$root"
Write-Host "  桌面目录：$desktop"

# ── 移除模式 ──
if ($Remove) {
    Write-Head '移除桌面捷径'
    foreach ($p in @($mainLnk, $stopLnk)) {
        if (Test-Path $p) {
            Remove-Item $p -Force
            Write-Host "  ✓ 已移除 $(Split-Path -Leaf $p)" -ForegroundColor Green
        } else {
            Write-Host "  - 不存在，略过：$(Split-Path -Leaf $p)"
        }
    }
    Write-Host ''
    Write-Host '  完成。' -ForegroundColor Green
    exit 0
}

# ── 前置检查 ──
Write-Head '检查必要档案'
$missing = @()
foreach ($f in @($launchVbs, $stopVbs, $cmdFile)) {
    if (-not (Test-Path $f)) { $missing += $f }
}
if ($missing.Count -gt 0) {
    Write-Host '  ✗ 找不到下列档案，请确认专案完整：' -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "      $_" -ForegroundColor Red }
    exit 1
}
Write-Host '  ✓ launch-hidden.vbs / stop-hidden.vbs / start.cmd 都在' -ForegroundColor Green

# 图示不存在就先生成
if (-not (Test-Path $icon)) {
    if (Test-Path $makeIcon) {
        Write-Host '  - 图示不存在，正在生成…'
        & node $makeIcon | Out-Null
    } else {
        Write-Host '  ! 找不到 tools\make-icon.mjs，将使用预设图示' -ForegroundColor Yellow
    }
}
if (Test-Path $icon) {
    Write-Host "  ✓ 图示：$icon" -ForegroundColor Green
}

# ── 建立捷径 ──
Write-Head '建立桌面捷径'

$shell = New-Object -ComObject WScript.Shell

function New-LauncherShortcut {
    param(
        [string]$Path,
        [string]$VbsPath,
        [string]$Description
    )
    $lnk = $shell.CreateShortcut($Path)
    $lnk.TargetPath       = $wscript
    $lnk.Arguments        = """$VbsPath"""
    $lnk.WorkingDirectory = $root
    $lnk.Description      = $Description
    $lnk.WindowStyle      = 1
    if (Test-Path $icon) { $lnk.IconLocation = $icon }
    $lnk.Save()
}

if ($ShowWindow) {
    # 可见视窗模式：指向 .cmd，方便盯着日志看
    $lnk = $shell.CreateShortcut($mainLnk)
    $lnk.TargetPath       = $cmdFile
    $lnk.WorkingDirectory = $root
    $lnk.Description      = '客诉周报采集工具（会显示黑色视窗）'
    $lnk.WindowStyle      = 1
    if (Test-Path $icon) { $lnk.IconLocation = $icon }
    $lnk.Save()
    Write-Host '  ✓ 已建立「客诉周报工具」（可见视窗模式）' -ForegroundColor Green
} else {
    New-LauncherShortcut -Path $mainLnk -VbsPath $launchVbs -Description '客诉周报采集工具（背景执行，不显示视窗）'
    Write-Host '  ✓ 已建立「客诉周报工具」（背景执行）' -ForegroundColor Green
}

New-LauncherShortcut -Path $stopLnk -VbsPath $stopVbs -Description '结束客诉周报工具（停止背景服务）'
Write-Host '  ✓ 已建立「结束客诉周报工具」' -ForegroundColor Green

# ── 读回验证（不只看档案存不存在）──
Write-Head '验证捷径内容'
foreach ($p in @($mainLnk, $stopLnk)) {
    if (-not (Test-Path $p)) {
        Write-Host "  ✗ 建立失败：$p" -ForegroundColor Red
        exit 1
    }
    $v = $shell.CreateShortcut($p)
    $name = Split-Path -Leaf $p
    Write-Host "  $name"
    Write-Host "      目标      : $($v.TargetPath)"
    Write-Host "      参数      : $($v.Arguments)"
    Write-Host "      开始位置  : $($v.WorkingDirectory)"
    Write-Host "      图示      : $($v.IconLocation)"
    $targetOk = Test-Path ($v.Arguments.Trim('"'))
    if (-not $targetOk) {
        Write-Host "      ✗ 参数指向的档案不存在！" -ForegroundColor Red
        exit 1
    }
}

Write-Host ''
Write-Host '  安装完成。' -ForegroundColor Green
Write-Host ''
Write-Host '  使用方式：'
Write-Host '    • 双击桌面的「客诉周报工具」→ 自动在背景启动并打开界面'
Write-Host '    • 用完想关掉 → 双击「结束客诉周报工具」，或按界面右上角「关闭工具」'
Write-Host ''
