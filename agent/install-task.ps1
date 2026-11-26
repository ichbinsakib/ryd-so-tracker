<#
  Registers the SO Review agent in Windows Task Scheduler for the signed-in user (needs Outlook desktop and the share).
  It starts every 2 minutes in --auto mode: it does a full review when one is requested from the SO Review page, or when the
  last full review is older than fullEveryMinutes (30). Runs only while this user is signed in (Outlook needs the session).
  Install:   powershell -ExecutionPolicy Bypass -File agent\install-task.ps1
  Remove:    Unregister-ScheduledTask -TaskName 'SO Review Agent' -Confirm:$false
#>
$ErrorActionPreference = 'Stop'
$agentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# a UNC path works in the task even if the Z: drive letter is not mapped yet
$drive = (Get-Item $agentDir).PSDrive
if ($drive.DisplayRoot) { $agentDir = $agentDir -replace ('^' + [regex]::Escape($drive.Root.TrimEnd('\'))), $drive.DisplayRoot }
$node = (Get-Command node).Source
$log = Join-Path $env:LOCALAPPDATA 'so-review-agent\agent.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
# node runs directly (cmd.exe cannot start in a network folder); the agent writes its own log with --log
$action = New-ScheduledTaskAction -Execute ('"' + $node + '"') -Argument ('"' + (Join-Path $agentDir 'so-review-agent.js') + '" --auto --log') -WorkingDirectory (Split-Path $log)
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'SO Review Agent' -Description 'SO Review: checks NEED TO RELEASE folders against the Shop Order app and Outlook release emails' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
"Registered 'SO Review Agent' (every 2 minutes, full review every 30). Log: $log"
