<#
.SYNOPSIS
  dsh-mcp-hub 安装器（Windows / PowerShell 5.1+）

.DESCRIPTION
  把 dsh-mcp-hub 装进某个 DSH profile，优先走 DSH 自己的插件通道：
      dsh plugin --profile <name> add <spec>
  （这一步由 DSH 转发给 pnpm，装完自动把包名写进 dsh.profile.bundles。）

  如果机器上没有 pnpm，或者 dsh 不在 PATH 里，就退回「只用 node + npm pack」的
  等价实现：把打包好的目录复制进 profile 的 node_modules，再由
  scripts/profile-manifest.mjs 改写 profile 清单。

  脚本本身不依赖任何第三方模块；所有路径都用 Join-Path 拼，因此也能在
  Linux/macOS 的 PowerShell 7 上原样跑（这也是它被自动化测试覆盖的原因）。

.PARAMETER Profile
  目标 profile 名，默认 web（也就是 dsh web 用的那个）。

.PARAMETER Source
  安装来源，原样交给包管理器。可以是 npm 包名、tarball 路径、本地目录、git+https://…
  不传时：自动 npm pack 本仓库，用打出来的 tarball 安装。

.PARAMETER FromRegistry
  从 npm registry 安装 dsh-mcp-hub（等价于 -Source dsh-mcp-hub）。

.PARAMETER Uninstall
  卸载：从 profile 依赖与 dsh.profile.bundles 里移除，并删掉 node_modules 下的目录。

.PARAMETER Verify
  安装后顺手跑一遍自检：平台层单测 + 内置 MCP 服务清单。

.EXAMPLE
  .\install.ps1
  打包当前仓库并装进 web profile。

.EXAMPLE
  .\install.ps1 -Profile web -Verify

.EXAMPLE
  .\install.ps1 -Uninstall

.NOTES
  装完必须重启一次 DSH（dsh web）。之后在设置页的「MCP 工具」里加/卸 MCP 服务
  都不再需要重启。
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string] $Profile = 'web',
    [string] $Source = '',
    [switch] $FromRegistry,
    [switch] $Uninstall,
    [switch] $Verify
)

$ErrorActionPreference = 'Stop'
$PluginName = 'dsh-mcp-hub'
$PluginRoot = $PSScriptRoot
$OnWindows = ($env:OS -eq 'Windows_NT')

function Write-Step([string] $Message) { Write-Host ('==> ' + $Message) -ForegroundColor Cyan }
function Write-Ok([string] $Message) { Write-Host ('  OK  ' + $Message) -ForegroundColor Green }
function Write-Warn2([string] $Message) { Write-Host ('  !   ' + $Message) -ForegroundColor Yellow }
function Write-Fail([string] $Message) { Write-Host ('  X   ' + $Message) -ForegroundColor Red }

function Resolve-Node {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($null -ne $cmd) { return $cmd.Source }
    $candidates = @()
    if ($env:ProgramFiles) { $candidates += (Join-Path (Join-Path $env:ProgramFiles 'nodejs') 'node.exe') }
    if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path (Join-Path ${env:ProgramFiles(x86)} 'nodejs') 'node.exe') }
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path (Join-Path (Join-Path $env:LOCALAPPDATA 'Programs') 'nodejs') 'node.exe') }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    return $null
}

function Get-NodeMajor([string] $NodePath) {
    try {
        $raw = & $NodePath -p 'process.versions.node'
        if ($LASTEXITCODE -ne 0) { return 0 }
        return [int](($raw -split '\.')[0])
    } catch { return 0 }
}

# DSH 启动器：要么是 PATH 里的 dsh，要么是 node + 全局安装的 bin.js。
function Resolve-DshLauncher([string] $NodePath) {
    $cmd = Get-Command dsh -ErrorAction SilentlyContinue
    if ($null -ne $cmd) { return @{ Exe = $cmd.Source; Prefix = @() } }

    $roots = @()
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if ($null -ne $npm) {
        try {
            $global = & $npm.Source root -g 2>$null
            if ($LASTEXITCODE -eq 0 -and $global) { $roots += $global.Trim() }
        } catch { }
    }
    if ($env:APPDATA) { $roots += (Join-Path (Join-Path $env:APPDATA 'npm') 'node_modules') }
    foreach ($root in $roots) {
        $bin = Join-Path (Join-Path (Join-Path $root '@deepseek-ai') 'dsh') (Join-Path 'lib' 'bin.js')
        if (Test-Path $bin) { return @{ Exe = $NodePath; Prefix = @($bin) } }
    }
    return $null
}

function Test-Pnpm {
    $cmd = Get-Command pnpm -ErrorAction SilentlyContinue
    return ($null -ne $cmd)
}

function Invoke-PnpmAdd([string] $ProfileDir, [string] $Spec) {
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($null -eq $pnpm) { return 127 }
    Push-Location $ProfileDir
    try {
        & $pnpm.Source add $Spec
        return $LASTEXITCODE
    } finally { Pop-Location }
}

# 打包当前仓库 → 返回 tarball 绝对路径（失败返回 $null）。
function Invoke-PluginPack([string] $WorkDir) {
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if ($null -eq $npmCmd) { return $null }
    if (-not (Test-Path $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }
    Push-Location $PluginRoot
    try {
        $raw = & $npmCmd.Source pack --json --pack-destination $WorkDir 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        $text = ($raw | Out-String).Trim()
        $parsed = $text | ConvertFrom-Json
        $file = $parsed[0].filename
        if (-not $file) { return $null }
        return (Join-Path $WorkDir $file)
    } catch {
        return $null
    } finally { Pop-Location }
}

# 目标目录可能是 pnpm link 出来的符号链接：删链接别删到源仓库。
function Remove-PluginDir([string] $Target) {
    if (-not (Test-Path $Target)) { return $false }
    $item = Get-Item $Target -Force
    $isLink = $false
    if ($null -ne $item.PSObject.Properties['LinkType']) { $isLink = [bool]$item.LinkType }
    if ($isLink -and $OnWindows) { cmd /c rmdir "$Target" | Out-Null; return $true }
    Remove-Item $Target -Recurse -Force
    return $true
}

# 没有 pnpm 时的兜底：解开 tarball，把 package 目录复制进 profile 的 node_modules。
function Install-ByCopy([string] $Tarball, [string] $ProfileDir) {
    if (-not $Tarball -or -not (Test-Path $Tarball)) { return $false }
    $tar = Get-Command tar -ErrorAction SilentlyContinue
    if ($null -eq $tar) { $tar = Get-Command bsdtar -ErrorAction SilentlyContinue }
    $staging = Join-Path ([System.IO.Path]::GetTempPath()) ('mcp-hub-stage-' + [System.Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    try {
        if ($null -ne $tar) {
            & $tar.Source -xzf $Tarball -C $staging
            if ($LASTEXITCODE -ne 0) { return $false }
        } elseif (Test-Path $PluginRoot) {
            # 连 tar 都没有（极老系统）：直接从仓库目录复制。
            Copy-Item -Path $PluginRoot -Destination (Join-Path $staging 'package') -Recurse -Force
        } else { return $false }

        $packageDir = Join-Path $staging 'package'
        $probe = Join-Path (Join-Path $packageDir 'lib') 'index.js'
        if (-not (Test-Path $probe)) {
            # 有些 tar 实现不带顶层目录名
            $alt = Join-Path (Join-Path $staging 'lib') 'index.js'
            if (Test-Path $alt) { $packageDir = $staging } else { return $false }
        }
        $modulesDir = Join-Path $ProfileDir 'node_modules'
        if (-not (Test-Path $modulesDir)) { New-Item -ItemType Directory -Path $modulesDir -Force | Out-Null }
        $target = Join-Path $modulesDir $PluginName
        Remove-PluginDir $target | Out-Null
        Copy-Item -Path $packageDir -Destination $target -Recurse -Force
        return $true
    } catch {
        Write-Warn2 ('复制安装失败：' + $_.Exception.Message)
        return $false
    } finally {
        Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# 把本地路径写成包管理器认的 file: 规格。
# Windows 上路径是 C:\Users\... 反斜杠：npm/pnpm 对 file: 里的反斜杠处理不一致，
# 统一换成正斜杠最省事（'C:/Users/...' 三种包管理器都认）。
function ConvertTo-FileSpec([string] $Path) {
    $full = $Path
    try { $full = (Resolve-Path -LiteralPath $Path).Path } catch { }
    return 'file:' + ($full -replace '\\', '/')
}

function Get-ManifestHelper {
    return (Join-Path (Join-Path $PluginRoot 'scripts') 'profile-manifest.mjs')
}

function Invoke-Manifest([string] $NodePath, [string] $ProfileDir, [string] $Mode, [string] $Spec) {
    $helper = Get-ManifestHelper
    if (-not (Test-Path $helper)) { throw ('找不到清单助手：' + $helper) }
    $argv = @($helper, '--profile-dir', $ProfileDir, '--mode', $Mode, '--name', $PluginName)
    if ($Spec -and $Spec -ne '') { $argv += @('--spec', $Spec) }
    # 注意：PowerShell 函数会把子进程的 stdout 也当成「返回值」。
    # 不吞掉它，调用方拿到的就是「一段 JSON + 退出码」的数组，判断必然出错。
    & $NodePath @argv | Out-Null
    return $LASTEXITCODE
}

# ── 0) 基本环境 ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host 'dsh-mcp-hub 安装器' -ForegroundColor White
Write-Host ''

$nodePath = Resolve-Node
if ($null -eq $nodePath) {
    Write-Fail '没找到 Node.js。'
    Write-Host '      安装：winget install OpenJS.NodeJS.LTS'
    Write-Host '      装完重开一个 PowerShell 再跑本脚本。'
    exit 1
}
$nodeMajor = Get-NodeMajor $nodePath
if ($nodeMajor -lt 20) {
    Write-Fail ('Node.js 版本过低：' + $nodeMajor + '（插件要求 >= 20）')
    Write-Host '      升级：winget upgrade OpenJS.NodeJS.LTS'
    exit 1
}
Write-Ok ('Node.js ' + (& $nodePath -p 'process.versions.node') + ' · ' + $nodePath)

$dshHome = if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne '') { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profilesDir = Join-Path $dshHome 'profiles'
$profileDir = Join-Path $profilesDir $Profile
$manifest = Join-Path $profileDir 'package.json'
Write-Ok ('DSH home：' + $dshHome)
Write-Ok ('目标 profile：' + $profileDir)

if (-not (Test-Path $manifest)) {
    Write-Fail '这个 profile 还没初始化过（没有 package.json）。'
    Write-Host ('      先启动一次：dsh --profile ' + $Profile)
    Write-Host '      或者在 DSH 桌面端里用一次这个 profile，然后重跑本脚本。'
    exit 1
}

# ── 1) 卸载 ─────────────────────────────────────────────────────────────────
if ($Uninstall) {
    Write-Step '卸载 dsh-mcp-hub'
    $launcher = Resolve-DshLauncher $nodePath
    if ($null -ne $launcher -and (Test-Pnpm)) {
        $argv = @($launcher.Prefix + @('plugin', '--profile', $Profile, 'remove', $PluginName))
        & $launcher.Exe @argv
        if ($LASTEXITCODE -eq 0) { Write-Ok 'dsh plugin remove 完成' } else { Write-Warn2 'dsh plugin remove 失败，继续用清单助手清理' }
    } elseif ($null -ne $launcher) {
        Write-Warn2 '没找到 pnpm，跳过 dsh plugin remove'
    } else {
        Write-Warn2 '没找到 dsh 启动器，只清理 profile 清单与文件'
    }

    Invoke-Manifest $nodePath $profileDir 'uninstall' '' | Out-Null
    Write-Ok '已从 profile 依赖与 dsh.profile.bundles 移除'

    $target = Join-Path (Join-Path $profileDir 'node_modules') $PluginName
    if (Remove-PluginDir $target) { Write-Ok ('已删除 ' + $target) }
    Write-Host ''
    Write-Host '卸载完成。重启一次 DSH 后生效。' -ForegroundColor Green
    exit 0
}

# ── 2) 决定安装来源 ─────────────────────────────────────────────────────────
$spec = $Source
$tarball = $null
if ($FromRegistry -and $spec -eq '') { $spec = $PluginName }
$packDir = $null

if ($spec -eq '') {
    Write-Step '打包当前插件（npm pack）'
    $packDir = Join-Path ([System.IO.Path]::GetTempPath()) ('mcp-hub-pack-' + [System.Guid]::NewGuid().ToString('N'))
    $tarball = Invoke-PluginPack $packDir
    if ($null -eq $tarball) {
        Write-Fail 'npm pack 失败；可以改用 -Source <包名|路径|tarball> 指定来源。'
        exit 1
    }
    $spec = ConvertTo-FileSpec $tarball
    Write-Ok ('tarball：' + $tarball)
} else {
    Write-Ok ('安装来源：' + $spec)
}

# ── 3) 优先走 DSH 自己的插件通道 ────────────────────────────────────────────
$done = $false
$launcher = Resolve-DshLauncher $nodePath
if ($null -eq $launcher) {
    Write-Warn2 'PATH 里没有 dsh，也没找到全局安装的 @deepseek-ai/dsh，改用兜底安装'
} elseif (-not (Test-Pnpm)) {
    Write-Warn2 'PATH 里没有 pnpm（DSH 的插件通道需要它），改用兜底安装'
    Write-Host '      想用官方通道的话：corepack enable pnpm  或  npm i -g pnpm'
} else {
    Write-Step ('dsh plugin --profile ' + $Profile + ' add ' + $spec)
    $argv = @($launcher.Prefix + @('plugin', '--profile', $Profile, 'add', $spec))
    & $launcher.Exe @argv
    if ($LASTEXITCODE -eq 0) {
        $done = $true
        Write-Ok 'DSH 插件通道安装完成（bundles 已由 dsh 对账）'
    } else {
        Write-Warn2 ('DSH 插件通道失败（退出码 ' + $LASTEXITCODE + '），改用兜底安装')
    }
}

# ── 4) 兜底：pnpm → 复制 → npm install ──────────────────────────────────────
if (-not $done) {
    if (Test-Pnpm) {
        Write-Step ('pnpm add ' + $spec)
        $code = Invoke-PnpmAdd $profileDir $spec
        if ($code -eq 0) { $done = $true; Write-Ok 'pnpm 安装完成' }
        else { Write-Warn2 ('pnpm 安装失败（退出码 ' + $code + '）') }
    }

    if (-not $done -and $tarball) {
        Write-Step '直接复制安装（不需要 pnpm）'
        if (Install-ByCopy $tarball $profileDir) { $done = $true; Write-Ok '已复制进 profile 的 node_modules' }
        else { Write-Warn2 '复制安装失败' }
    }

    if (-not $done) {
        $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
        if ($null -ne $npmCmd) {
            Write-Step ('npm install --prefix ... ' + $spec)
            & $npmCmd.Source install --prefix $profileDir --no-audit --no-fund --loglevel=error $spec
            if ($LASTEXITCODE -eq 0) { $done = $true; Write-Ok 'npm 安装完成' }
            else { Write-Warn2 ('npm 安装失败（退出码 ' + $LASTEXITCODE + '）') }
        }
    }

    if (-not $done) {
        Write-Fail '三种安装方式都没成功。手动安装：'
        Write-Host ('      dsh plugin --profile ' + $Profile + ' add ' + $spec)
        exit 1
    }
}

# ── 5) 无论走哪条路，都用清单助手做一次对账（幂等）─────────────────────────
Write-Step '对账 profile 清单（dsh.profile.bundles / dependencies）'
$code = Invoke-Manifest $nodePath $profileDir 'install' $spec
if ($code -ne 0) {
    Write-Fail '清单助手失败；profile 的 package.json 可能没写全。'
    exit 1
}

# 本地 tarball 会被 npm/pnpm 留在临时目录里，挪到 DSH home 下留档再固定 spec。
if ($tarball) {
    $keepDir = Join-Path (Join-Path $dshHome 'mcp-hub') 'dist'
    New-Item -ItemType Directory -Path $keepDir -Force | Out-Null
    $keep = Join-Path $keepDir ([System.IO.Path]::GetFileName($tarball))
    Copy-Item $tarball $keep -Force
    Invoke-Manifest $nodePath $profileDir 'install' (ConvertTo-FileSpec $keep) | Out-Null
    Write-Ok ('tarball 已留档：' + $keep)
    if ($packDir) { Remove-Item $packDir -Recurse -Force -ErrorAction SilentlyContinue }
}

# ── 6) 自检 ─────────────────────────────────────────────────────────────────
if ($Verify) {
    Write-Step '自检'
    $test = Join-Path (Join-Path $PluginRoot 'tests') 'platform.test.mjs'
    if (Test-Path $test) {
        & $nodePath $test | Out-Null
        if ($LASTEXITCODE -eq 0) { Write-Ok '平台层单测通过（含 Windows 分支）' } else { Write-Warn2 '平台层单测未通过' }
    }
    $entry = Join-Path (Join-Path (Join-Path (Join-Path $profileDir 'node_modules') $PluginName) 'lib') (Join-Path 'servers' 'main.js')
    if (Test-Path $entry) {
        & $nodePath $entry list | Out-Null
        if ($LASTEXITCODE -eq 0) { Write-Ok '内置 MCP 服务清单可读' } else { Write-Warn2 '内置 MCP 服务清单读取失败' }
    } else {
        Write-Warn2 ('profile 里没有找到插件：' + $entry)
    }
}

Write-Host ''
Write-Host '装好了。下一步：' -ForegroundColor Green
Write-Host '  1) 重启一次 DSH：dsh web        （必须重启，插件才会被加载）'
Write-Host '  2) 打开 设置 → MCP 工具，先点「体检」看环境缺什么'
Write-Host '  3) 缺 Python 版 MCP 服务所需运行器时：winget install astral-sh.uv'
Write-Host ''
Write-Host '卸载：.\install.ps1 -Uninstall'
exit 0
