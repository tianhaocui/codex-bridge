@echo off
setlocal
set SCRIPT_DIR=%~dp0
set GRADLE_HOME_DIR=%SCRIPT_DIR%.tooling\gradle-8.10.2
if not exist "%GRADLE_HOME_DIR%\bin\gradle.bat" (
  echo 未找到内置 Gradle：%GRADLE_HOME_DIR%\bin\gradle.bat
  exit /b 1
)
if "%GRADLE_USER_HOME%"=="" set GRADLE_USER_HOME=%SCRIPT_DIR%.gradle-home
call "%GRADLE_HOME_DIR%\bin\gradle.bat" %*
