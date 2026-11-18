# The runner's helper on Windows (src/win32-helper.ts starts it, hidden, and
# keeps it running). What ps and lsof tell the runner on a Mac, Windows
# only tells through PowerShell, and a new powershell.exe for each question
# takes a second or more; this one answers in about a tenth of that.
#
# One request a line on stdin, as JSON: { "id": n, "op": ..., ... }. One
# answer a line on stdout: { "id": n, "ok": true, "result": "<text>" } or
# { "id": n, "ok": false, "error": "<why>" }. Results are plain text the
# runner parses, so PowerShell 5's JSON quirks (a one-item array coming out
# as the item) can't change their shape.
#
#   processes   every process, one "pid ppid created" line each, created
#               as a FILETIME (100 ns since 1601, UTC; 0 when Windows
#               won't say)
#   jobAssign   put pid (a CLI just started) in a new job called name, and
#               answer when that process started (a FILETIME)
#   jobForget   let go of the job called name without ending it
#   jobEnd      end every process still in the job called name
#   privateDir  make the folder at path this user's and SYSTEM's only,
#               and answer this user's SID
#   snapshot    for port: every established connection to it, with the
#               pid holding the client's end, and every process (below),
#               in one answer, so any number of connections waiting to be
#               looked up share one (peer.ts)
#
# The runner doesn't run this file: it reads it once when it starts and
# passes it to powershell.exe as -EncodedCommand, so changing the file
# under a running runner changes nothing (Codex's review, 18 Nov 2026).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Only Windows' own modules, from System32 by full path, and nothing loaded
# by name from anywhere else: PowerShell would otherwise find a module
# called NetTCPIP or CimCmdlets in Documents\WindowsPowerShell\Modules first,
# and a thread can write there (Codex's third review, 18 Nov 2026). The
# commands below are called by their modules' names too.
$PSModuleAutoLoadingPreference = 'None'
$system = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules"
$env:PSModulePath = $system
foreach ($m in 'Microsoft.PowerShell.Utility', 'CimCmdlets', 'NetTCPIP') {
  Import-Module "$system\$m" -ErrorAction Stop
}
# Job Objects (jobAssign, jobEnd), through kernel32 declared in memory:
# Add-Type would compile C# to files in %TEMP%, which a thread can write.
$asm = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'ThreadbearNative'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$type = $asm.DefineDynamicModule('ThreadbearNative').DefineType('ThreadbearNative.Kernel32', 'Public, Class')
$importCtor = [Runtime.InteropServices.DllImportAttribute].GetConstructor([string])
$lastError = [Runtime.InteropServices.DllImportAttribute].GetField('SetLastError')
function Declare($name, $ret, [Type[]]$params) {
  $m = $type.DefinePInvokeMethod($name, 'kernel32.dll', [Reflection.MethodAttributes]'Public, Static, PinvokeImpl', [Reflection.CallingConventions]::Standard, $ret, $params, [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
  $m.SetImplementationFlags('PreserveSig')
  $m.SetCustomAttribute((New-Object Reflection.Emit.CustomAttributeBuilder($importCtor, @('kernel32.dll'), [Reflection.FieldInfo[]]@($lastError), @($true))))
}
Declare 'CreateJobObjectW' ([IntPtr]) @([IntPtr], [string])
Declare 'OpenJobObjectW' ([IntPtr]) @([UInt32], [bool], [string])
Declare 'OpenProcess' ([IntPtr]) @([UInt32], [bool], [UInt32])
Declare 'AssignProcessToJobObject' ([bool]) @([IntPtr], [IntPtr])
Declare 'TerminateJobObject' ([bool]) @([IntPtr], [UInt32])
Declare 'CloseHandle' ([bool]) @([IntPtr])
$long = [long].MakeByRefType()
Declare 'GetProcessTimes' ([bool]) @([IntPtr], $long, $long, $long, $long)
$K = $type.CreateType()
function LastError { [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
# The job of each CLI this helper has put in one, by name. A helper started
# again later opens one by its name instead.
$jobs = @{}

[Console]::OutputEncoding = [Text.Encoding]::UTF8
$in = [Console]::In
$out = [Console]::Out

while ($true) {
  $line = $in.ReadLine()
  if ($null -eq $line) { break }
  $id = $null
  try {
    $req = $line | Microsoft.PowerShell.Utility\ConvertFrom-Json
    $id = $req.id
    switch ($req.op) {
      'ping' { $result = 'pong' }
      'processes' {
        $rows = CimCmdlets\Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate | ForEach-Object {
          $created = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }
          "$($_.ProcessId) $($_.ParentProcessId) $created"
        }
        $result = ($rows -join "`n")
      }
      'snapshot' {
        # Each established connection to the port, as its client sees it
        # ("c localAddress localPort remoteAddress remotePort pid"), then
        # every process ("p pid ppid created"). Taken after the connections,
        # so a process holding one is in the list.
        # None found is an error of its own kind (ObjectNotFound), and the
        # only one that means none: any other (access denied, the provider
        # failing) fails the snapshot, so it can't pass for "nobody's".
        try {
          $found = @(NetTCPIP\Get-NetTCPConnection -State Established -RemotePort ([int]$req.port) -ErrorAction Stop)
        } catch {
          if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw }
          $found = @()
        }
        $conns = $found | Where-Object { $_ } | ForEach-Object {
          "c $($_.LocalAddress) $($_.LocalPort) $($_.RemoteAddress) $($_.RemotePort) $($_.OwningProcess)"
        }
        $procs = CimCmdlets\Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate | ForEach-Object {
          $created = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }
          "p $($_.ProcessId) $($_.ParentProcessId) $created"
        }
        $result = ((@($conns) + @($procs)) -join "`n")
      }
      'jobAssign' {
        # A job of its own for a CLI the runner has just started (it holds
        # the child's handle, so the pid is still that CLI's), named by the
        # runner with a random part. Everything the CLI starts from then on
        # is in it too, and can't leave.
        $name = [string]$req.name
        if ($name -notmatch '^Local\\threadbear-job-[0-9a-f]{32}$') { throw "not a job name: $name" }
        # Not one that's there already (someone else's): looked for first, as
        # PowerShell's own calls can overwrite the error code checked below.
        $there = $K::OpenJobObjectW(0x0008, $false, $name)
        if ($there -ne [IntPtr]::Zero) { [void]$K::CloseHandle($there); throw 'a job by that name already exists' }
        $job = $K::CreateJobObjectW([IntPtr]::Zero, $name)
        $err = LastError
        if ($job -eq [IntPtr]::Zero) { throw "CreateJobObject failed ($err)" }
        # 183: there's already one by that name, which isn't ours to use.
        if ($err -eq 183) { [void]$K::CloseHandle($job); throw 'a job by that name already exists' }
        # PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION
        $proc = $K::OpenProcess(0x1101, $false, [UInt32]$req.pid)
        if ($proc -eq [IntPtr]::Zero) { $err = LastError; [void]$K::CloseHandle($job); throw "OpenProcess failed ($err)" }
        # When it started, read before it goes in: one that started after
        # notAfter got the CLI's pid after the CLI went, and is left alone
        # (once in a job, a process can't be taken out of it).
        $created = [long]0; $exit = [long]0; $kernel = [long]0; $user = [long]0
        $timed = $K::GetProcessTimes($proc, [ref]$created, [ref]$exit, [ref]$kernel, [ref]$user)
        if (-not $timed -or $created -gt [long]$req.notAfter) {
          [void]$K::CloseHandle($proc); [void]$K::CloseHandle($job)
          throw "process $($req.pid) isn't the one the runner started"
        }
        $ok = $K::AssignProcessToJobObject($job, $proc)
        $err = LastError
        [void]$K::CloseHandle($proc)
        if (-not $ok) { [void]$K::CloseHandle($job); throw "AssignProcessToJobObject failed ($err)" }
        $jobs[$name] = $job
        $result = if ($timed) { [string]$created } else { '0' }
      }
      'jobEnd' {
        # Ends every process still in the CLI's job. None left: the job has
        # gone with them, and there's nothing to do.
        $name = [string]$req.name
        if ($name -notmatch '^Local\\threadbear-job-[0-9a-f]{32}$') { throw "not a job name: $name" }
        $job = $jobs[$name]
        $jobs.Remove($name)
        # JOB_OBJECT_TERMINATE
        if (-not $job) { $job = $K::OpenJobObjectW(0x0008, $false, $name) }
        if ($job -eq [IntPtr]::Zero -or -not $job) { $result = 'gone' } else {
          $ok = $K::TerminateJobObject($job, 1)
          $err = LastError
          [void]$K::CloseHandle($job)
          if (-not $ok) { throw "TerminateJobObject failed ($err)" }
          $result = 'ended'
        }
      }
      'jobForget' {
        # Lets go of a job without ending it (one that got a process that
        # wasn't the CLI).
        $name = [string]$req.name
        $job = $jobs[$name]
        $jobs.Remove($name)
        if ($job) { [void]$K::CloseHandle($job) }
        $result = 'ok'
      }
      'privateDir' {
        # The secrets folder made this user's and SYSTEM's only (win-acl.ts):
        # its access list replaced whole, inheriting nothing, so no grant
        # anyone added before survives; everything already in it made to
        # take only what the folder passes on; then read back to check.
        $dir = New-Object IO.DirectoryInfo ([string]$req.path)
        if (-not $dir.Exists) { throw "no folder at $($dir.FullName)" }
        $link = [IO.FileAttributes]::ReparsePoint
        if ($dir.Attributes -band $link) { throw "$($dir.FullName) is a link, so its target isn't changed" }
        $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $system = New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'
        $both = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($sid in $me, $system) {
          $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $both, 'None', 'Allow')))
        }
        $dir.SetAccessControl($acl)
        $inside = @($dir.GetFileSystemInfos('*', [IO.SearchOption]::AllDirectories))
        foreach ($item in $inside) {
          if ($item.Attributes -band $link) { throw "$($item.FullName) is a link" }
          $own = if ($item -is [IO.DirectoryInfo]) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
          $own.SetAccessRuleProtection($false, $false)
          $item.SetAccessControl($own)
        }
        $allowed = @($me.Value, $system.Value)
        foreach ($item in @($dir) + $inside) {
          $item.Refresh()
          foreach ($rule in $item.GetAccessControl().GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            if ($allowed -notcontains $rule.IdentityReference.Value) { throw "$($item.FullName) still lets $($rule.IdentityReference.Value) in" }
          }
        }
        $result = $me.Value
      }
      default { throw "unknown op: $($req.op)" }
    }
    $answer = @{ id = $id; ok = $true; result = [string]$result } | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress
  } catch {
    $answer = @{ id = $id; ok = $false; error = [string]$_ } | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress
  }
  $out.WriteLine($answer)
  $out.Flush()
}
