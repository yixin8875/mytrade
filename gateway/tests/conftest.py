"""让 pytest 能直接 import gateway 下的模块（它们按脚本目录做绝对导入）。"""

import sys
from pathlib import Path

GATEWAY_DIR = Path(__file__).resolve().parents[1]
if str(GATEWAY_DIR) not in sys.path:
    sys.path.insert(0, str(GATEWAY_DIR))
