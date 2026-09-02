export function siteHostname(url: string): string {
  return new URL(url).hostname;
}

export function formatWorkTree(cases: { siteUrl: string }[]): string {
  const lines = cases.map((item, index, items) => {
    const branch = index === items.length - 1 ? '└── ' : '├── ';
    return `${branch}${siteHostname(item.siteUrl)}`;
  });

  return `work/\n${lines.join('\n')}`;
}
