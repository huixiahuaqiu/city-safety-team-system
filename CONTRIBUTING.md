# 城市安全数智创新团队文献管理系统 - 团队协作指南

## 🚀 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/lnc1970238795-create/city-safety-team-system.git
cd city-safety-team-system
```

### 2. 配置 Git（首次使用必须执行）

```bash
# 设置用户信息（替换为你的真实信息）
git config user.name "你的名字"
git config user.email "your.email@example.com"

# 设置换行符处理（Windows 用户）
git config core.autocrlf true
# macOS/Linux 用户
git config core.autocrlf input

# 设置 pull 使用 rebase 策略（减少无意义的合并提交）
git config pull.rebase true

# 设置提交消息模板
git config commit.template .gitmessage

# 设置默认推送行为（只推送当前分支）
git config push.default current

# 设置拉取时自动 rebase
git config branch.autoSetupRebase always
```

### 3. 安装依赖

```bash
cd 123123
npm install
```

### 4. 启动开发服务器

```bash
node server.cjs
# 访问 http://localhost:3000/
```

---

## 🌿 分支管理策略

### 分支说明

| 分支名 | 用途 | 保护级别 |
|--------|------|----------|
| `main` | 生产分支，只接受合并请求 | 🔒 受保护 |
| `develop` | 开发主分支，日常开发合并目标 | ⚠️ 建议 PR |
| `feature/<功能名>` | 新功能开发分支 | 自由 |
| `fix/<问题名>` | Bug 修复分支 | 自由 |
| `hotfix/<问题名>` | 紧急修复（直接从 main 拉取） | 自由 |

### 工作流程

```
main ←── develop ←── feature/xxx ←── 你的工作
         ↑                │
         └────── 合并后删除 ─┘
```

### 开发流程（每日操作）

#### 第一步：开始新功能前，确保 develop 是最新的

```bash
git checkout develop
git pull origin develop
```

#### 第二步：创建功能分支

```bash
# 功能分支命名规范：feature/功能描述
git checkout -b feature/patent-batch-import

# 修复分支命名规范：fix/问题描述
git checkout -b fix/cors-proxy-error

# 紧急修复：直接从 main 拉取
git checkout -b hotfix/security-patch main
```

#### 第三步：开发并提交

```bash
# 查看变更状态
git status

# 添加文件到暂存区
git add .

# 提交（会自动触发钩子检查）
git commit -m "feat(patent): 新增专利批量导入功能"
```

#### 第四步：推送到远程并创建 PR

```bash
git push origin feature/patent-batch-import
# 然后在 GitHub 上创建 Pull Request，目标分支选择 develop
```

#### 第五步：合并后清理本地分支

```bash
git checkout develop
git pull origin develop
git branch -d feature/patent-batch-import
```

---

## 📝 提交消息规范（Conventional Commits）

### 格式

```
<类型>(<作用域>): <简短描述>

[可选的详细说明]

[可选：Closes #问题编号]
```

### 类型说明

| 类型 | 含义 | 示例 |
|------|------|------|
| `feat` | 新功能 | `feat(patent): 新增专利批量导入功能` |
| `fix` | Bug 修复 | `fix(server): 修复代理服务器 CORS 问题` |
| `docs` | 文档更新 | `docs(readme): 更新快速开始章节` |
| `style` | 代码格式（不影响逻辑） | `style(index): 统一缩进风格` |
| `refactor` | 代码重构 | `refactor(api): 重构 Supabase 请求封装` |
| `perf` | 性能优化 | `perf(chart): 优化大数据量图表渲染` |
| `test` | 测试相关 | `test(proxy): 添加代理服务器单元测试` |
| `chore` | 构建/工具变更 | `chore(deps): 升级 SheetJS 版本` |
| `ci` | CI/CD 配置 | `ci(actions): 添加自动部署工作流` |

### 作用域（Scope）参考

- `patent` - 专利台账模块
- `paper` - 论文成果模块
- `server` - 代理服务器
- `chart` - 图表可视化
- `auth` - 认证授权
- `excel` - Excel 处理
- `ai` - AI 相关功能
- `ui` - 界面样式

> **提示**：Git 钩子会自动验证提交消息格式，不符合规范会阻止提交。
> 如需临时跳过，使用 `git commit --no-verify`（不推荐常规使用）。

---

## ⚠️ 冲突解决指南

### 预防冲突

1. **频繁同步**：每天开始工作前先 `git pull`
2. **小步提交**：避免长时间不提交导致大量冲突
3. **沟通协作**：多人修改同一文件时提前沟通

### 解决冲突步骤

```bash
# 1. 拉取最新代码（可能出现冲突）
git pull origin develop

# 2. 如果有冲突，打开冲突文件，找到以下标记：
# <<<<<<< HEAD
# 你的代码
# =======
# 别人的代码
# >>>>>>> feature/xxx

# 3. 手动选择保留哪部分代码，删除冲突标记

# 4. 标记冲突已解决
git add <冲突文件>

# 5. 继续提交
git commit -m "fix: 解决合并冲突"
```

### 使用 VS Code 解决冲突

VS Code 会在冲突文件中显示「Accept Current Change」「Accept Incoming Change」「Accept Both Changes」按钮，直接点击即可。

---

## 🔐 敏感信息保护

### 禁止提交的内容

- ❌ API 密钥（阿里云百炼 API Key、百度 OCR 密钥）
- ❌ Supabase 真实密钥
- ❌ 数据库连接字符串
- ❌ 个人账号密码

### 正确做法

1. 将敏感配置写入 `config.local.js`（已被 `.gitignore` 忽略）：

```javascript
// config.local.js（不要提交到 Git）
window.APP_CONFIG = {
    supabaseUrl: 'https://your-project.supabase.co',
    supabaseKey: 'your-publishable-key',
    apiKey: 'your-aliyun-api-key'
};
```

2. 在 `index.html` 中引用该文件（已配置自动读取）

3. 使用环境变量或占位符替代硬编码

---

## 🔄 常见 Git 操作速查

### 撤销操作

```bash
# 撤销工作区修改（未 add）
git checkout -- <文件名>

# 撤销暂存（已 add，未 commit）
git reset HEAD <文件名>

# 撤销上次提交（保留修改）
git reset --soft HEAD~1

# 彻底回退到某次提交（危险操作，慎用）
git reset --hard <commit-hash>
```

### 暂存当前工作

```bash
# 临时保存当前修改
git stash

# 切换分支处理其他事情...

# 恢复保存的修改
git stash pop
```

### 查看历史

```bash
# 查看提交历史
git log --oneline -20

# 查看某文件的修改历史
git log -p -- 123123/index.html

# 查看某次提交的详情
git show <commit-hash>
```

---

## 👥 团队协作规范

### Code Review 流程

1. 功能开发完成后，推送到远程分支
2. 在 GitHub 创建 Pull Request（目标分支：`develop`）
3. 邀请至少 1 名团队成员 Review
4. 根据 Review 意见修改代码
5. 确认无问题后合并到 `develop`

### 发布流程

1. `develop` 分支功能稳定后，创建 PR 合并到 `main`
2. 合并后在 GitHub 创建 Release 标签（如 `v1.0.0`）
3. 更新 CHANGELOG 记录版本变更

### 沟通规范

- 修改公共文件前在团队群通知
- 遇到合并冲突主动联系相关开发者
- 重要功能变更需附带文档说明

---

## 🛠️ 钩子说明

本仓库配置了以下 Git 钩子（位于 `.git/hooks/`）：

| 钩子 | 触发时机 | 检查内容 |
|------|----------|----------|
| `pre-commit` | `git commit` 执行前 | 敏感信息、大文件、合并冲突标记、debugger 语句 |
| `commit-msg` | 提交消息编辑后 | 提交消息是否符合 Conventional Commits 格式 |

> 钩子仅在本地生效，团队成员需要各自克隆后自动生效。
> 如需临时跳过：`git commit --no-verify -m "..."`（不推荐）

---

## 📞 遇到问题？

| 问题 | 解决方法 |
|------|----------|
| 提交被钩子拒绝 | 查看错误信息，修复问题后重新提交 |
| 推送失败（rejected） | 先执行 `git pull --rebase` 拉取最新代码 |
| 不小心提交了敏感信息 | 立即告知团队，使用 `git reset --soft HEAD~1` 撤销，并更换密钥 |
| 合并冲突无法解决 | 联系相关开发者一起处理 |
| 钩子无法执行（权限问题） | Windows: Git Bash 通常会自动处理；手动执行 `chmod +x .git/hooks/*` |
