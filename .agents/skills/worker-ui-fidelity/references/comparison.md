# 截图对比与展示工具

工具生成派生图、检查证据声明，不控制设备、不修改输入图，也不作视觉合格判定。简单任务可以只用严格对照工具；需要批量展示时再用 gallery，需要机器覆盖检查时再用 bundle。

使用实际可用的 Python 3.9+ 与提供 `Image.Resampling` 的 Pillow；先在选定解释器检查 `import PIL`。缺依赖时遵循项目依赖规则，不改产品依赖或全局环境。命令中的 `<skill-root>` 是本技能实际目录，`<evidence-dir>` 是项目约定的证据位置；没有固定项目名、Git 根或产物路径要求。

## 严格对照

```bash
python3 <skill-root>/scripts/compare_screenshots.py \
  --reference <evidence-dir>/approved.png \
  --actual <evidence-dir>/capture.png \
  --output <evidence-dir>/round-01
```

输出目录必须尚不存在，每轮使用新目录。默认要求输入图经 EXIF 方向处理后的尺寸相等；没有自动缩放、平移、最佳匹配或遮罩。

需要去掉系统栏或统一倍率时显式声明坐标映射，例如运行图上下各 80px 为系统栏，内容 1080×1920，对应 540×960 基准：

```bash
python3 <skill-root>/scripts/compare_screenshots.py \
  --reference <evidence-dir>/approved.png --actual <evidence-dir>/capture.png \
  --actual-crop 0,80,1080,1920 --resize-actual \
  --alignment-note '去掉上下80px系统栏；内容1080x1920以2x倍率映射至540x960' \
  --output <evidence-dir>/round-02
```

- `--reference-crop` / `--actual-crop`：`x,y,width,height`，坐标基于 EXIF 方向处理后的输入像素；区域必须在图内。
- `--resize-actual`：仅在裁切后宽高比完全相同时，等比缩放运行图至基准大小；LANCZOS 重采样会影响像素差异。
- 任何裁切／缩放都须填写非空 `--alignment-note`；工具无法判断理由是否合理。局部必须有同语义坐标和全图检查，不能隐藏错误区域。

| 产物 | 用途 |
|---|---|
| `reference.png`、`actual.png` | 处理后的比较输入；原始文件不变 |
| `side-by-side.png` | 左基准、右实现，无额外缩放 |
| `overlay.png` | 各 50% 叠图，查看轮廓错位 |
| `difference.png` | RGB 最大通道差灰度图，亮度放大 4 倍并截断，用于定位 |
| `report.json` | 原图路径／SHA256／尺寸、裁切缩放、差异统计；`visual_status` 固定为 `not_reviewed` |

`changed_pixels` 计任一 RGB 通道不同的像素；`changed_fraction` 是其占比较区域的比例，**不是还原度或相似度评分**。`difference_bounds` 为比较坐标系的 `[left, top, right, bottom]`，右下不包含；无差异为 null。

EXIF 方向会统一，透明部分合成白底；工具不做 ICC 色彩管理、抗锯齿容差或动态区域屏蔽。尽量统一色彩配置、字体渲染与稳定内容；透明边缘仍需在真实背景检查。退出 0 只表示生成完成，输入／处理错误退出 2；零差异也不证明截图来源、交互或验收成立。

## 批量展示

读取[证据包格式](evidence-bundle.md)后，可把已有 manifest 生成带标签的左右预览：

```bash
python3 <skill-root>/scripts/visual_review_gallery.py <visual-review.json> \
  --expect-version <candidate-id> --output <evidence-dir>/gallery-01
```

已有独立计划时追加 `--plan <visual-plan.json> --expect-plan-sha <frozen-sha256>`，两项须一起提供。只有使用可选 `source_binding` 时才需要 Git，使用 `--repo <checkout>` 指明；无计划旧记录仍可展示，覆盖范围标为 `declared_regions`，不补造计划或提升为完整计划验收。

每个 capture 输出 `capture-001.png` 等左右合图，另有 `contact-sheet.png` 总览、`index.html` 阅图入口和 `gallery.json` 原图路径／哈希／放置位置。默认单侧 540px，`--panel-width` 可设 128..1600，高图预览上限 1600px。左右独立等比适配并补白、始终保留全图；`presentation_only` 表明它们不是同一比例尺，不能用于像素对齐、叠图或还原率。

需要局部预览时，在计划的可选 `details` 中声明同语义区域（EXIF 校正后的原图像素）：

```json
{"details": [{
  "id": "button-edge", "capture": "default",
  "reference_crop": [20, 100, 300, 80],
  "actual_crop": [30, 150, 450, 120],
  "note": "同一按钮区域，实际图为1.5x倍率；数值替换为本次实测"
}]}
```

局部只是补充，工具先输出所有完整全图；最多 64 个全图／局部对。输入无效、裁切越界、媒体过期、覆盖缺失或输出目录已存在时退出 1；退出 0 仅表示预览生成完成。工具不把 pending 改成 pass。

实际阅图后，在最终答复直接展示相关合图，注明页面／状态／候选、左确认图右实现和剩余偏差。展示平台不支持图片时提供可访问入口并说明限制。历史工具演示不冒充本次产品验收。

## 工具回归

修改脚本时运行现有公开 CLI 回归；只改说明文字时核对链接与格式，不为文档新增镜像测试：

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s <skill-root>/tests -v
```

测试使用独立临时目录，遵循运行环境的临时目录设置并自动清理。图像 fixture 只验证工具行为；测试通过不代表真实界面已通过验收。
