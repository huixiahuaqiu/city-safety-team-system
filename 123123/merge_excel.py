#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Excel文件合并工具 - 保留每个文件的完整表头结构

功能说明：
1. 读取当前文件夹下所有.xlsx文件
2. 合并成一个总表，保存为merged_total.xlsx
3. 每个原始文件的数据都保留其完整的表头行
4. 不同文件的数据按顺序堆叠，每个文件的表头都单独显示
5. 代码逻辑清晰，每行都有详细注释

作者：AI助手
日期：2026年4月2日
"""

# 导入操作系统模块，用于文件路径操作
import os

# 导入glob模块，用于文件模式匹配
import glob

# 导入pandas库，用于数据处理和Excel操作
import pandas as pd

# 导入pathlib模块，用于现代化的路径操作
from pathlib import Path


def merge_excel_files_with_headers():
    """
    合并Excel文件函数 - 保留每个文件的原始表头
    
    这个函数会：
    1. 扫描当前目录下的所有.xlsx文件
    2. 逐个读取每个文件（包含其表头）
    3. 将所有文件的数据垂直堆叠
    4. 保存到merged_total.xlsx文件
    """
    
    # 获取当前工作目录的路径对象
    current_dir = Path.cwd()
    
    # 打印当前工作目录信息，方便用户确认位置
    print(f"📁 当前工作目录: {current_dir}")
    
    # 使用glob查找所有.xlsx文件
    excel_files = glob.glob("*.xlsx")
    
    # 过滤掉输出文件本身，防止循环引用问题
    excel_files = [f for f in excel_files if not f.startswith('merged_total')]
    
    # 检查是否找到任何Excel文件
    if not excel_files:
        # 如果没有找到文件，打印错误信息并返回False
        print("❌ 错误：当前目录下没有找到任何.xlsx文件！")
        return False
    
    # 打印找到的文件数量和文件名列表
    print(f"✅ 找到 {len(excel_files)} 个Excel文件:")
    
    # 遍历文件列表，打印每个文件的序号和名称
    for i, file in enumerate(excel_files, 1):
        print(f"   {i}. {file}")
    
    # 创建一个空列表来存储所有DataFrame对象
    dataframes = []
    
    # 遍历每个Excel文件进行处理
    for file in excel_files:
        try:
            # 打印正在处理的文件名
            print(f"\n📊 正在处理文件: {file}")
            
            # 读取Excel文件，header=None表示不自动将第一行作为列名
            # 这样可以保留原始的表头行作为数据的一部分
            df = pd.read_excel(file, header=None)
            
            # 检查DataFrame是否为空
            if df.empty:
                # 如果文件为空，打印警告并跳过
                print(f"⚠️  警告: 文件 {file} 为空，跳过...")
                continue
            
            # 打印文件的基本信息（行数和列数）
            print(f"   文件 {file} 包含 {df.shape[0]} 行, {df.shape[1]} 列")
            
            # 将读取的DataFrame添加到列表中
            dataframes.append(df)
            
        except Exception as e:
            # 捕获读取文件时的任何异常
            print(f"❌ 错误: 读取文件 {file} 时出错: {str(e)}")
            # 继续处理下一个文件，而不是终止整个程序
            continue
    
    # 检查是否成功读取了任何有效的文件
    if not dataframes:
        # 如果没有成功读取任何文件，打印错误信息
        print("❌ 错误：没有成功读取任何有效的Excel文件！")
        return False
    
    # 开始合并所有DataFrame
    print(f"\n🔄 开始合并 {len(dataframes)} 个文件的数据...")
    
    try:
        # 使用pd.concat垂直堆叠所有DataFrame
        # ignore_index=True 重新索引行号
        # sort=False 保持原始列顺序
        merged_df = pd.concat(dataframes, ignore_index=True, sort=False)
        
        # 打印合并后的数据统计信息
        print(f"✅ 合并完成！总共有 {merged_df.shape[0]} 行, {merged_df.shape[1]} 列")
        
        # 定义输出文件名
        output_file = "merged_total.xlsx"
        
        # 将合并后的数据保存到Excel文件
        # index=False 表示不保存行索引
        # engine='openpyxl' 指定使用openpyxl引擎写入.xlsx文件
        merged_df.to_excel(output_file, index=False, engine='openpyxl')
        
        # 打印保存成功的消息
        print(f"💾 成功保存合并结果到: {output_file}")
        
        # 返回True表示操作成功
        return True
        
    except Exception as e:
        # 捕获合并或保存过程中的异常
        print(f"❌ 错误: 合并或保存数据时出错: {str(e)}")
        # 返回False表示操作失败
        return False


def main():
    """
    主函数 - 程序的入口点
    
    这个函数负责：
    1. 显示程序标题和分隔线
    2. 调用合并函数
    3. 处理程序执行结果
    4. 提供用户友好的结束提示
    """
    
    # 打印程序标题和装饰分隔线
    print("=" * 60)
    print("🚀 Excel文件合并工具（保留原始表头版本）")
    print("=" * 60)
    
    try:
        # 调用合并函数并获取执行结果
        success = merge_excel_files_with_headers()
        
        # 根据执行结果打印相应的成功或失败消息
        if success:
            print("\n✨ 程序执行成功！所有文件已合并完成！")
        else:
            print("\n💥 程序执行失败！请检查错误信息。")
            
    except KeyboardInterrupt:
        # 捕获用户按Ctrl+C中断程序的情况
        print("\n\n⏹️  用户中断程序执行")
        
    except Exception as e:
        # 捕获其他未预期的异常
        print(f"\n💥 未预期的错误: {str(e)}")
    
    # 程序结束前等待用户按键，防止窗口立即关闭
    print("\n按回车键退出程序...")
    input()


# 程序入口点检查
# 只有直接运行此脚本时才会执行main()函数
if __name__ == "__main__":
    # 调用主函数开始程序执行
    main()
