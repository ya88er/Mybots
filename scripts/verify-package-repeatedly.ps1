$ErrorActionPreference = 'Continue'
$root = 'E:\Minimax\Projects\Minibots'

# The packaged app is launched, and it checks itself. A check that passes
# once may be passing by luck, so this runs the whole verification several
# times in a row and reports every run.
#
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-package-repeatedly.ps1 [times]
$times = if ($args.Count -ge 1) { [int]$args[0] } else { 3 }
$failed = 0

for ($i = 1; $i -le $times; $i += 1) {
  Get-Process MiniBots, electron -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3

  $output = node "$root\scripts\verify-package.mjs" 2>&1
  $summary = $output | Select-String -Pattern '^===' | Select-Object -Last 1
  $failures = $output | Select-String -Pattern '^FAIL'

  Write-Output ("run {0}/{1}: {2}" -f $i, $times, $summary)
  foreach ($failure in $failures) {
    Write-Output ("  {0}" -f $failure)
  }
  if ($LASTEXITCODE -ne 0) { $failed += 1 }
}

Write-Output ''
if ($failed -eq 0) {
  Write-Output "all $times runs passed"
  exit 0
}
Write-Output "$failed of $times runs failed"
exit 1
