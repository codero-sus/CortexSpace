"""Quick fibonacci — ask the agent to `run python` to see it execute."""
import time


def fib(n: int) -> int:
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a


if __name__ == "__main__":
    t0 = time.perf_counter()
    print("fib(50) =", fib(50))
    print(f"took {(time.perf_counter() - t0) * 1000:.3f} ms")
