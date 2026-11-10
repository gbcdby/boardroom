# 增量参考、迭代与可选工具

## 维护参考

沿用现有规范和素材入口，列出稳定原则、可变维度和排除项。查看新增参考及受影响旧图，判断是补强主线、启发分支、纠正规则还是不采用。保留来源与依据；弃用画法退出当前正向简报，原始资料按项目规则保留。

新搜集的候选先用于当前任务；长期入库按用户要求或已有授权执行，不因工具存在而额外归档。资料入库与风格采纳分别记录。只读请求不修改资料或规范。

## 资料 CLI（按需使用）

先核实 Python 3.10+ 和目标目录。只有项目确实需要模板化参考管理时才运行初始化；已有 Spec／页面合同不为使用工具重建。`--docs-dir` 是项目内相对路径，省略时默认为 `docs/design-direction`。

```bash
python <skill-root>/scripts/art_direction.py init --project-root <project-root> --docs-dir <reference-docs-dir>
python <skill-root>/scripts/art_direction.py ingest --project-root <project-root> --docs-dir <reference-docs-dir> --input <source-folder>
python <skill-root>/scripts/art_direction.py check --project-root <project-root> --docs-dir <reference-docs-dir>
python <skill-root>/scripts/color_check.py check --palette <palette-json> --json
```

- `init`：补缺整套美术模板、参考目录和元数据，不覆盖已有文件；学习模板不自动复制。
- `ingest`：要求已有兼容 manifest，按内容哈希去重、原样复制图片并分配编号，登记为待审；不修改风格规范。Pillow 可用时核实尺寸与可解码性，不可用则明确未核实。错误时可有部分成功，检查返回的 imported／errors，不因退出非零重复全部导入。
- `check`：只读核对 manifest、图片哈希、JSON 与相对链接，不进行视觉审阅。仅适用本工具的数据格式，不作为任意项目文档的强制检查器。
- `color_check`：只计算显式 `readability_pairs` 的纯色前景／背景，输入和范围见 [色彩系统](color-systems.md)。它不采样图片、不证明透明叠色或设备可读性。

工具结果不等于审美或可用性通过。仅在需要打包时检查 ZIP；常规迭代只检查本次受影响资料。

## 设计迭代

记录可见问题、对应动作与复查范围。诊断配色时控制其他变量；探索整体方向时允许相关关系一起变化，不声称单变量因果。连续没有改善时重查问题假设与可变范围，不重复加重同一种调整。按 [比较实验](evaluation-lab.md)选样本，无须每轮执行全部实验或全量回归。

整体画风结论留在美术方向，页面细节留在页面合同。按 [项目学习](project-learning.md)在授权内保存新结论、范围与替代关系；项目专属决定不回填通用技能。
