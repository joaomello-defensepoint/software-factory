import { Box, type SxProps, type Theme } from '@mui/material';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mono } from '../../theme';

/** GitHub-flavoured markdown (tables, task lists, strikethrough, autolinks) styled for the dark theme. */
const styles: SxProps<Theme> = {
  wordBreak: 'break-word',
  '& p': { my: 0.5 },
  '& ul, & ol': { pl: 2.5, my: 0.5 },
  '& li': { my: 0.25 },
  '& h1, & h2, & h3, & h4': { mt: 1.5, mb: 0.5, lineHeight: 1.3 },
  '& h1': { fontSize: 18 },
  '& h2': { fontSize: 16 },
  '& h3': { fontSize: 14.5 },
  '& h4': { fontSize: 13.5 },
  '& hr': { border: 0, borderTop: '1px solid', borderColor: 'divider', my: 1.5 },
  '& blockquote': { m: 0, my: 0.75, pl: 1.5, borderLeft: '3px solid', borderColor: 'divider', color: 'text.secondary' },
  '& a': { color: 'primary.main' },
  '& code': { fontFamily: mono, fontSize: '0.92em', bgcolor: 'rgba(255,255,255,0.06)', borderRadius: 0.5, px: 0.5, py: '1px' },
  '& pre': { bgcolor: 'rgba(0,0,0,0.35)', border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1, my: 0.75, overflow: 'auto', fontSize: 12, '& code': { bgcolor: 'transparent', p: 0, fontSize: 'inherit' } },
  '& table': { borderCollapse: 'collapse', my: 1, fontSize: '0.95em', display: 'block', maxWidth: '100%', overflowX: 'auto', width: 'max-content' },
  '& th, & td': { border: '1px solid', borderColor: 'divider', px: 1, py: 0.5, textAlign: 'left', verticalAlign: 'top' },
  '& th': { bgcolor: 'rgba(255,255,255,0.06)', fontWeight: 600, whiteSpace: 'nowrap' },
  '& tbody tr:nth-of-type(even)': { bgcolor: 'rgba(255,255,255,0.025)' },
  '& input[type=checkbox]': { mr: 0.75 },
  '& img': { maxWidth: '100%' },
};

export function Markdown({ children, sx }: { children: string; sx?: SxProps<Theme> }) {
  return (
    <Box sx={[styles, ...(Array.isArray(sx) ? sx : [sx])] as SxProps<Theme>}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </Box>
  );
}
