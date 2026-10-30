import os
from typing import Optional

@dataclass
class Foo(Base):
    """docstring
    spanning lines"""
    x: int = 0

    async def run(self, *args, **kw) -> Optional[str]:
        # comment
        s = f"val {self.x!r:>4}" + r'raw\n' + b'bytes'
        if s is not None and 0x1F < 1_000 or True:
            yield from range(3)
        lambda a, b=1: a @ b
        return None if ... else s
