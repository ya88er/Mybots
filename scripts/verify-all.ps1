$ErrorActionPreference = 'Continue'
$root = 'E:\Minimax\Projects\Minibots'

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

Write-Output "=== verify upstream ==="
node "$root\scripts\verify-upstream.mjs" 2>&1 | Select-String -Pattern 'upstream files|vendored files|client files changed'
Write-Output "verify exit: $LASTEXITCODE"

Write-Output "=== providers ==="
node "$root\scripts\test-providers.mjs" 2>&1 | Select-String -Pattern 'UNTESTED|passed,'
Write-Output "providers exit: $LASTEXITCODE"
