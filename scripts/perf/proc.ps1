# The process tree under -Root: CPU seconds, memory and GPU memory per process (nse-perf round 2).
param([string]$Root)
$all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine
$queue = New-Object System.Collections.Queue
$queue.Enqueue([uint32]$Root)
$seen = @{}; $ids = @()
while ($queue.Count) {
    $id = $queue.Dequeue(); if ($seen.ContainsKey($id)) { continue }; $seen[$id] = $true
    $ids += $id
    foreach ($c in $all) { if ($c.ParentProcessId -eq $id) { $queue.Enqueue([uint32]$c.ProcessId) } }
}
$gpu = @{}
try {
    $samples = (Get-Counter '\GPU Process Memory(*)\Dedicated Usage','\GPU Process Memory(*)\Shared Usage' -ErrorAction SilentlyContinue).CounterSamples
    foreach ($s in $samples) {
        if ($s.InstanceName -match '^pid_(\d+)_') {
            $p = [int]$Matches[1]
            if (-not $gpu.ContainsKey($p)) { $gpu[$p] = @{ dedicated = 0; shared = 0 } }
            if ($s.Path -like '*dedicated usage') { $gpu[$p].dedicated += $s.CookedValue } else { $gpu[$p].shared += $s.CookedValue }
        }
    }
} catch { }
$out = @()
foreach ($id in $ids) {
    $w = $all | Where-Object { $_.ProcessId -eq $id } | Select-Object -First 1
    try { $p = Get-Process -Id $id -ErrorAction Stop } catch { continue }
    $type = 'browser'
    if ($w.CommandLine -match '--type=([\w-]+)') { $type = $Matches[1] }
    if ($w.CommandLine -match '--utility-sub-type=([\w.]+)') { $type += ':' + $Matches[1] }
    if ($p.ProcessName -ne 'chrome') { $type = $p.ProcessName }
    $g = $gpu[[int]$id]
    $out += [pscustomobject]@{
        pid = $id; type = $type
        cpu = [math]::Round($p.TotalProcessorTime.TotalSeconds, 3)
        ws = $p.WorkingSet64; priv = $p.PrivateMemorySize64
        gpuDedicated = $(if ($g) { $g.dedicated } else { 0 }); gpuShared = $(if ($g) { $g.shared } else { 0 })
    }
}
$out | ConvertTo-Json -Compress
