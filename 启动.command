#!/bin/bash
cd "$HOME/duo-xp" || { echo "找不到 ~/duo-xp"; read; exit 1; }
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
