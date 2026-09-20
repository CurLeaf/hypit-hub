# Load .env into the current PowerShell session, then run hypit with secrets available.
$envFile = Join-Path $PSScriptRoot ".env"
if (-not (Test-Path $envFile)) {
  Write-Error "Missing $envFile — copy .env.example to .env and fill in your keys."
  exit 1
}
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
  $name, $value = $_ -split '=', 2
  if ($name) { Set-Item -Path "env:$name" -Value $value }
}
Write-Host "Loaded: OPENAI_API_KEY, H3_VIDEO_API_KEY, HYPIT_CHAT_MODEL"
Write-Host "Run hypit from repo root, for example:"
Write-Host "  node bin/hypit.mjs runtime up --workspace examples/byok-openai-compatible --runtime examples/byok-openai-compatible/hypit.runtime.json"
