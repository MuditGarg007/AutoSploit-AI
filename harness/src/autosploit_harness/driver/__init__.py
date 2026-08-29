"""driver — orchestration slice (docs/harness.md §1 DRIVER, §8 eval).

Target config + scope in → build the graph → run the loop → report out. The
driver IS the eval harness: the same code runs both a live engagement and a
scored Juice Shop run (§8). Its signature is a frozen seam (§9) so the control
plane invokes it unchanged.
"""
