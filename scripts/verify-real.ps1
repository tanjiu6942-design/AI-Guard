# 手工验收脚本: 启动 AI Guard 后运行, 检查关键指标
$ErrorActionPreference = 'Continue'

Write-Host "=== AI Guard 手工验收 ===" -ForegroundColor Cyan

# 1. 出口一致性
Write-Host "`n[1/4] 出口一致性检查" -ForegroundColor Yellow
$targets = @(
    @{ host = 'claude.ai'; label = 'claude.ai' },
    @{ host = 'chatgpt.com'; label = 'chatgpt.com' },
    @{ host = 'www.cloudflare.com'; label = 'cloudflare' }
)
$ips = @{}
foreach ($t in $targets) {
    try {
        $r = Invoke-RestMethod -Uri "https://$($t.host)/cdn-cgi/trace" -TimeoutSec 15
        $ip = ($r -split "`n" | Where-Object { $_ -match '^ip=' }) -replace '^ip=', ''
        $ips[$t.label] = $ip.Trim()
        Write-Host "  $($t.label.PadRight(14)) -> $ip"
    } catch {
        Write-Host "  $($t.label.PadRight(14)) -> 失败: $_" -ForegroundColor Red
    }
}
$distinct = $ips.Values | Sort-Object -Unique
if ($distinct.Count -eq 1) {
    Write-Host "  结果: 一致 ✓" -ForegroundColor Green
} else {
    Write-Host "  结果: 不一致 ✗ 这是防封最关键的问题" -ForegroundColor Red
}

# 2. 长连接
Write-Host "`n[2/4] 长连接稳定性" -ForegroundColor Yellow
try {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $job = Start-Job -ScriptBlock {
        try {
            $r = Invoke-WebRequest -Uri 'https://ws.chatgpt.com/' -TimeoutSec 40 -UseBasicParsing
            'ok'
        } catch { 'fail' }
    }
    Start-Sleep -Seconds 30
    $sw.Stop()
    $state = Receive-Job $job -Wait
    Remove-Job $job -Force
    Write-Host "  保持 30s: $(if($state -eq 'ok'){'未断 ✓'}else{'已断 ✗'})"
} catch {
    Write-Host "  测试异常: $_" -ForegroundColor Red
}

# 3. DNS
Write-Host "`n[3/4] 网卡 DNS 接管状态" -ForegroundColor Yellow
Get-NetAdapter | Where-Object {
    $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Meta|Mihomo|Clash|TUN|Loopback'
} | ForEach-Object {
    $d4 = (Get-DnsClientServerAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4).ServerAddresses
    $ok = $d4 -contains '198.18.0.2'
    Write-Host "  $($_.Name): $d4 $(if($ok){'✓'}else{'✗ 未接管'})"
}

# 4. 代理冲突
Write-Host "`n[4/4] 代理冲突" -ForegroundColor Yellow
$procs = Get-Process | Where-Object {
    $_.ProcessName -match 'clash|v2ray|xray|sing-box|hysteria|wireguard'
} | Select-Object -ExpandProperty ProcessName -Unique
if ($procs) {
    Write-Host "  检测到: $($procs -join ', ') 流量会先经过它" -ForegroundColor Yellow
} else {
    Write-Host "  未检测到其他代理 ✓" -ForegroundColor Green
}

Write-Host "`n=== 验收结束 ===" -ForegroundColor Cyan
