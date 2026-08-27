import os
readme = "## aibuilder\n"
with open(os.path.join(os.path.dirname(__file__),'README.md'),'w') as f:
    f.write(readme)
