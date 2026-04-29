# 导入必要的库
import pandas as pd  # 用于读取和处理Excel数据
import matplotlib.pyplot as plt  # 用于绘制图表
import numpy as np  # 用于数值计算

# 设置中文字体支持（避免中文乱码）
plt.rcParams['font.sans-serif'] = ['SimHei']  # 使用黑体
plt.rcParams['axes.unicode_minus'] = False  # 解决负号显示问题

# 1. 读取Excel文件中的三个工作表
print("正在读取Excel文件...")
cost_df = pd.read_excel('data.xlsx', sheet_name='成本结构')  # 读取成本结构工作表
material_df = pd.read_excel('data.xlsx', sheet_name='材料消耗')  # 读取材料消耗工作表
worktime_df = pd.read_excel('data.xlsx', sheet_name='人员工时')  # 读取人员工时工作表

# 2. 创建分布柱状图 - 成本类型分布
print("正在生成成本类型分布柱状图...")
# 按成本类型分组并计算总金额
cost_by_type = cost_df.groupby('成本类型')['成本金额'].sum().sort_values(ascending=False)

# 创建柱状图
plt.figure(figsize=(10, 6))
bars = plt.bar(cost_by_type.index, cost_by_type.values, color='skyblue')
plt.title('成本类型分布柱状图', fontsize=16, fontweight='bold')
plt.xlabel('成本类型', fontsize=14)
plt.ylabel('成本金额（元）', fontsize=14)
plt.xticks(rotation=45, ha='right')
plt.grid(axis='y', alpha=0.3)

# 在柱子上方添加数值标签
for bar in bars:
    height = bar.get_height()
    plt.text(bar.get_x() + bar.get_width()/2., height,
             f'{height:,.0f}', ha='center', va='bottom')

# 调整布局并保存
plt.tight_layout()
plt.savefig('成本类型分布柱状图.png', dpi=300, bbox_inches='tight')
print("✅ 成本类型分布柱状图已保存为 '成本类型分布柱状图.png'")

# 3. 创建折线图 - 材料消耗趋势
print("正在生成材料消耗趋势折线图...")
# 将日期列转换为datetime类型并提取月份
material_df['日期'] = pd.to_datetime(material_df['日期'], format='%Y年-%m月-%d日')
material_df['月份'] = material_df['日期'].dt.to_period('M').astype(str)  # 提取年月，如"2026-01"
# 按月份分组计算总金额
monthly_consumption = material_df.groupby('月份')['总金额'].sum()

# 创建折线图
plt.figure(figsize=(12, 6))
plt.plot(monthly_consumption.index, monthly_consumption.values, 'o-', 
         color='green', linewidth=2, markersize=8)
plt.title('材料消耗趋势折线图', fontsize=16, fontweight='bold')
plt.xlabel('月份', fontsize=14)
plt.ylabel('总金额（元）', fontsize=14)
plt.grid(True, alpha=0.3)

# 在数据点上添加数值标签
for i, (month, value) in enumerate(monthly_consumption.items()):
    plt.text(month, value, f'{value:,.0f}', ha='center', va='bottom')

# 调整布局并保存
plt.tight_layout()
plt.savefig('材料消耗趋势折线图.png', dpi=300, bbox_inches='tight')
print("✅ 材料消耗趋势折线图已保存为 '材料消耗趋势折线图.png'")

# 4. 创建占比饼图 - 项目工时成本占比
print("正在生成项目工时成本占比饼图...")
# 按项目名称分组计算总工时成本
project_cost = worktime_df.groupby('项目名称')['工时成本'].sum().sort_values(ascending=False)

# 如果项目太多，只显示前5个，其余合并为"其他"
if len(project_cost) > 5:
    top5 = project_cost[:5]
    others = project_cost[5:].sum()
    if others > 0:
        project_cost_display = pd.concat([top5, pd.Series({'其他': others})])
    else:
        project_cost_display = top5
else:
    project_cost_display = project_cost

# 计算百分比
total = project_cost_display.sum()
percentages = [value/total*100 for value in project_cost_display.values]

# 创建饼图
plt.figure(figsize=(10, 8))
colors = plt.cm.Set3(np.linspace(0, 1, len(project_cost_display)))
wedges, texts, autotexts = plt.pie(
    project_cost_display.values, 
    labels=project_cost_display.index, 
    autopct='%1.1f%%',
    colors=colors,
    startangle=90,
    explode=[0.05]*len(project_cost_display)  # 突出显示所有扇形
)
plt.title('项目工时成本占比饼图', fontsize=16, fontweight='bold')

# 设置百分比文本样式
for autotext in autotexts:
    autotext.set_color('white')
    autotext.set_fontsize(12)
    autotext.set_weight('bold')

# 调整布局并保存
plt.tight_layout()
plt.savefig('项目工时成本占比饼图.png', dpi=300, bbox_inches='tight')
print("✅ 项目工时成本占比饼图已保存为 '项目工时成本占比饼图.png'")

# 5. 完成提示
print("\n" + "="*60)
print("✅ 所有图表已成功生成并保存！")
print("📊 生成的图表文件：")
print("   1. 成本类型分布柱状图.png")
print("   2. 材料消耗趋势折线图.png")
print("   3. 项目工时成本占比饼图.png")
print("="*60)