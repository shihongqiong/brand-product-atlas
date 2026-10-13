"""Configure this installed skill with the current user's bundled workspace tools."""
import argparse,json
from pathlib import Path

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--runtime',required=True,help='Dependency root returned by load_workspace_dependencies')
    parser.add_argument('--presentations',required=True,help='Installed presentations skill directory')
    args=parser.parse_args()
    root=Path(__file__).resolve().parent.parent
    runtime=Path(args.runtime).expanduser().resolve();presentations=Path(args.presentations).expanduser().resolve()
    required=[runtime/'python/bin/python3',runtime/'node/bin/node',runtime/'node/node_modules/@oai/artifact-tool',runtime/'node/node_modules/sharp',presentations/'container_tools/artifact_tool_utils.mjs']
    absent=[str(p) for p in required if not p.exists()]
    if absent:raise SystemExit('工作区组件未就绪，请先调用 load_workspace_dependencies 核验路径：\n'+'\n'.join(absent))
    modules=runtime/'node/node_modules';link=root/'scripts/node_modules'
    if link.is_symlink():
        if link.resolve()!=modules:raise SystemExit('已有不同的模块链接，请核验后自行调整，配置器不会覆盖它。')
    elif link.exists():raise SystemExit('scripts/node_modules 已存在，请核验其用途后再配置。')
    else:link.symlink_to(modules,target_is_directory=True)
    target=root/'runtime.local.json';temp=target.with_suffix('.tmp')
    temp.write_text(json.dumps({'runtime':str(runtime),'presentations':str(presentations)},ensure_ascii=False,indent=2),encoding='utf-8');temp.replace(target)
    print('已配置当前环境；runtime.local.json 与模块链接均不应提交 GitHub。')

if __name__=='__main__':main()
