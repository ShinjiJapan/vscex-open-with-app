# Builds OpenWithAppHost.exe from OpenWithAppHost.cs using the .NET Framework C#
# compiler that ships with Windows (no external SDK needed). Run this whenever the
# helper source changes, then commit the updated exe (it is shipped inside the VSIX).
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw "csc.exe (.NET Framework 4) not found" }

$src = Join-Path $dir 'OpenWithAppHost.cs'
$out = Join-Path $dir 'OpenWithAppHost.exe'
# /target:winexe -> GUI subsystem, so no console window ever flashes when spawned.
& $csc /nologo /optimize+ /target:winexe /out:$out $src
Write-Host "Built $out"
