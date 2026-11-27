param([string]$Mode)
$ErrorActionPreference = 'Continue'
$root = 'C:\sbx'
$out = Join-Path $root "results\$Mode"
New-Item -ItemType Directory -Force $out | Out-Null
Start-Transcript (Join-Path $out 'transcript.txt') | Out-Null
$summary = [ordered]@{ mode = $Mode; started = (Get-Date).ToString('o'); steps = @() }
function Step($name, $ok, $detail) { $script:summary.steps += [ordered]@{ step = $name; ok = [bool]$ok; detail = "$detail" }; Write-Output "STEP $name ok=$ok $detail" }
function Snap($name) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save((Join-Path $out "$name.png"))
  } catch { Write-Output "screenshot failed: $_" }
}
$programDir = Join-Path $env:LOCALAPPDATA 'Programs\Blaze UAV'
$exe = Join-Path $programDir 'Blaze UAV.exe'
$userData = Join-Path $env:APPDATA 'Blaze UAV'
function Install($file) {
  $p = Start-Process (Join-Path $root $file) -ArgumentList '/S' -Wait -PassThru
  Step "install $file" ($p.ExitCode -eq 0 -and (Test-Path $exe)) "exit $($p.ExitCode); exe present $(Test-Path $exe)"
  if (Test-Path $exe) { Step "installed version" $true ((Get-Item $exe).VersionInfo.ProductVersion) }
}
function RunApp($label, $seconds) {
  $app = Start-Process $exe -PassThru
  Start-Sleep -Seconds $seconds
  $engine = Get-Process drone-engine -ErrorAction SilentlyContinue
  Step "$label engine process" ($null -ne $engine) "drone-engine running: $($null -ne $engine)"
  Step "$label app alive" (-not $app.HasExited) "app running: $(-not $app.HasExited)"
  Snap $label
  Get-Process 'Blaze UAV' -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }
  Start-Sleep -Seconds 8
  Get-Process 'Blaze UAV', drone-engine -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}
function SaveData($label) {
  $dest = Join-Path $out "userdata-$label"
  if (Test-Path $userData) { Copy-Item $userData $dest -Recurse -Force -ErrorAction SilentlyContinue }
  Step "$label user data saved" (Test-Path $dest) $userData
}

if ($Mode -eq 'clean') {
  Step 'user data absent at start' (-not (Test-Path $userData)) $userData
  Install 'BlazeUAV-Setup-0.8.0.exe'
  RunApp 'first-start' 30
  SaveData 'after-first-start'
  $uninstaller = Get-ChildItem $programDir -Filter 'Uninstall*.exe' | Select-Object -First 1
  if ($uninstaller) {
    $p = Start-Process $uninstaller.FullName -ArgumentList '/S' -Wait -PassThru
    Start-Sleep -Seconds 10
    Step 'uninstall' (-not (Test-Path $exe)) "exit $($p.ExitCode); exe still present $(Test-Path $exe)"
  } else { Step 'uninstall' $false 'no uninstaller found' }
  Step 'user data kept after uninstall' (Test-Path $userData) $userData
}
elseif ($Mode -eq 'upgrade') {
  Install 'BlazeUAV-Setup-0.1.0.exe'
  RunApp 'old-version-start' 25
  Get-ChildItem (Join-Path $root 'old-userdata') -ErrorAction SilentlyContinue | Out-Null
  if (Test-Path (Join-Path $root 'old-userdata')) {
    Remove-Item $userData -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item (Join-Path $root 'old-userdata') $userData -Recurse -Force
    Step 'old user data placed' (Test-Path (Join-Path $userData 'blaze-uav.db')) $userData
  } else { Step 'old user data placed' $false 'missing C:\sbx\old-userdata' }
  Install 'BlazeUAV-Setup-0.8.0.exe'
  RunApp 'after-upgrade' 30
  SaveData 'after-upgrade'
}
$summary.finished = (Get-Date).ToString('o')
$summary | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $out 'summary.json') -Encoding utf8
Stop-Transcript | Out-Null
'done' | Set-Content (Join-Path $out 'DONE') -Encoding ascii
Start-Sleep -Seconds 3
shutdown /s /t 0
