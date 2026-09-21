@echo off
chcp 65001 >nul
title 阿男帮你推 验收测试
echo 阿男帮你推 Rust 验收测试
echo.
where cargo >nul 2>nul
if errorlevel 1 set "PATH=C:\Users\XC\.cargo\bin;%PATH%"
echo 正在检查 Rust 项目...
cargo check
if errorlevel 1 goto failed
echo.
echo 正在执行自动化测试...
cargo test
if errorlevel 1 goto failed
echo.
echo ========================================
echo 验收通过：cargo check 和 cargo test 均成功
echo ========================================
pause
exit /b 0
:failed
echo.
echo ========================================
echo 验收失败：请查看上面的错误信息
echo ========================================
pause
exit /b 1
