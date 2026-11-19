#!/bin/bash
# 项目目录：/Users/fengzhao/Projects/duolingo（旧 ~/duo-xp 链接已不存在）
cd "$(dirname "$0")" || { echo "找不到项目目录"; read; exit 1; }
clear
echo "=============================="
echo "  多邻国答案填充器"
echo "  填好答案后，检查/继续/结束由你点"
echo "=============================="
echo
[ -f hint.log ] && mv -f hint.log hint.log.prev
node hint.js 2>&1 | tee hint.log
echo
echo "-------------------------------"
echo "脚本已结束。按回车关闭窗口。"
read
