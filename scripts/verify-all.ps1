$ErrorActionPreference = 'Continue'
$root = 'E:\Minimax\Projects\Minibots'
$electron = "$root\node_modules\electron\dist\electron.exe"

# A stray Electron process holds the app's single-instance lock. When one is
# left over, the next run quits before it writes a single check, and the
# report is empty. The Electron runs are therefore preceded by a clean-up.
function Clear-StrayElectron {
  $stray = Get-Process electron -ErrorAction SilentlyContinue
  if ($stray) {
    Write-Output "(clearing $($stray.Count) stray Electron process(es))"
    Stop-Process -Name electron -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
}

Write-Output "=== typecheck ==="
node "$root\scripts\check-types.mjs"
Write-Output "typecheck exit: $LASTEXITCODE"

Write-Output "=== runtime ==="
node --test "$root\tests\runtime\**\*.test.mjs" 2>&1 | Select-String -Pattern '^ℹ (tests|pass|fail)'
Write-Output "runtime exit: $LASTEXITCODE"

Write-Output "=== desktop ==="
node --test --test-timeout=30000 "$root\tests\desktop\**\*.test.ts" 2>&1 | Select-String -Pattern '^ℹ (tests|pass|fail)'
Write-Output "desktop exit: $LASTEXITCODE"

Write-Output "=== integration ==="
node --test --test-timeout=30000 "$root\tests\integration\**\*.test.ts" 2>&1 | Select-String -Pattern '^ℹ (tests|pass|fail)'
Write-Output "integration exit: $LASTEXITCODE"

Write-Output "=== upstream ==="
node "$root\scripts\run-upstream-tests.mjs" 2>&1 | Select-String -Pattern '^ℹ (tests|pass|fail)'
Write-Output "upstream exit: $LASTEXITCODE"

Write-Output "=== build ==="
node "$root\scripts\build.mjs"
Write-Output "build exit: $LASTEXITCODE"

Write-Output "=== electron desktop suite ==="
Clear-StrayElectron
& $electron "$root\scripts\desktop-tests.mjs"
Get-Content "$root\desktop-tests-report.txt" | Select-String -Pattern '^(FAIL|===)'
Write-Output "electron desktop exit: $LASTEXITCODE"

Write-Output "=== electron shell smoke ==="
Clear-StrayElectron
& $electron "$root\scripts\smoke-electron-shell.mjs"
Get-Content "$root\shell-smoke-report.txt" | Select-String -Pattern '^(FAIL|===)'
Write-Output "electron smoke exit: $LASTEXITCODE"

Write-Output "=== verify upstream ==="
node "$root\scripts\verify-upstream.mjs" 2>&1 | Select-String -Pattern 'upstream files|vendored files|client files changed'
Write-Output "verify exit: $LASTEXITCODE"

Write-Output "=== providers ==="
node "$root\scripts\test-providers.mjs" 2>&1 | Select-String -Pattern 'UNTESTED|passed,'
Write-Output "providers exit: $LASTEXITCODE"

Write-Output "=== package ==="
if (Test-Path "$root\release\MiniBots-Setup-0.1.0-x64.exe") {
  Clear-StrayElectron
  Stop-Process -Name MiniBots -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  node "$root\scripts\verify-package.mjs" 2>&1 | Select-String -Pattern '^(FAIL|===|PASS  the packaged)'
  Write-Output "package exit: $LASTEXITCODE"
} else {
  Write-Output "(no installer in release/; run npm run dist:win first)"
}

