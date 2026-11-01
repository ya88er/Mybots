# Read the text of the app's windows.
#
# The packaged app shows an "Error" dialog when it cannot start. The dialog
# is a real Windows window, so its text can be read with the UI Automation
# API through PowerShell.
#
# The script takes the executable's name as its first argument, and defaults
# to MiniBots.
param(
  [string]$ProcessName = 'MiniBots'
)

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$process = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1

if (-not $process) {
  $process = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

if (-not $process) {
  Write-Output "no $ProcessName process"
  exit 0
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$condition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
  $process.Id
)
$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)

Write-Output "windows: $($windows.Count)"
foreach ($window in $windows) {
  Write-Output "--- window: '$($window.Current.Name)' class=$($window.Current.ClassName) ---"
  $all = $window.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  foreach ($element in $all) {
    $name = $element.Current.Name
    if ($name) { Write-Output "  [$($element.Current.ControlType.ProgrammaticName)] $name" }
  }
}
