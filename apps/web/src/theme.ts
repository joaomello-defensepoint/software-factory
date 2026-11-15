import { createTheme } from '@mui/material/styles';

export const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#7aa2f7' },
    secondary: { main: '#bb9af7' },
    success: { main: '#9ece6a' },
    warning: { main: '#e0af68' },
    error: { main: '#f7768e' },
    info: { main: '#7dcfff' },
    background: { default: '#16161e', paper: '#1a1b26' },
    divider: 'rgba(255,255,255,0.08)',
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    fontSize: 13,
    h6: { fontWeight: 600 },
    subtitle2: { fontWeight: 600 },
  },
  components: {
    MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
    MuiButton: { defaultProps: { size: 'small', disableElevation: true }, styleOverrides: { root: { textTransform: 'none', fontWeight: 600 } } },
    MuiChip: { defaultProps: { size: 'small' } },
    MuiTextField: { defaultProps: { size: 'small' } },
    MuiTooltip: { defaultProps: { arrow: true } },
  },
});

export const mono = 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace';
