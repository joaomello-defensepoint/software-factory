import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Box, Button, Checkbox, Chip, FormControlLabel, Paper, Radio, RadioGroup, Stack, TextField, Typography } from '@mui/material';
import type { HumanRequest } from '@sf/shared';
import { api } from '../api/client';
import { mono } from '../theme';
import { timeAgo } from '../components/common/format';

function RequestCard({ r }: { r: HumanRequest }) {
  const qc = useQueryClient();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [free, setFree] = useState<Record<string, string>>({});
  const answer = useMutation({
    mutationFn: (a: Record<string, string>) => api.post(`/api/requests/${r.id}/answer`, { answers: a }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['requests'] }),
  });
  const dismiss = useMutation({ mutationFn: () => api.post(`/api/requests/${r.id}/dismiss`), onSuccess: () => qc.invalidateQueries({ queryKey: ['requests'] }) });

  const ready = r.questions.every((q) => (answers[q.question] && answers[q.question].trim()) || (free[q.question] && free[q.question].trim()));
  const submit = () => {
    const a: Record<string, string> = {};
    for (const q of r.questions) a[q.question] = (free[q.question] && free[q.question].trim()) || answers[q.question] || '';
    answer.mutate(a);
  };

  return (
    <Paper variant="outlined" sx={{ p: 2, borderColor: r.kind === 'permission' ? 'info.main' : 'warning.main' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Chip label={r.kind === 'permission' ? 'permission' : 'question'} color={r.kind === 'permission' ? 'info' : 'warning'} />
        <Typography variant="subtitle2">{r.cardKey ? `${r.cardKey} · ` : ''}{r.cardTitle}</Typography>
        <Typography variant="caption" color="text.secondary">
          {r.role ? `${r.role} · ` : ''}{r.step ? `step ${r.step} · ` : ''}{timeAgo(r.createdAt)}
        </Typography>
      </Box>
      {r.kind === 'permission' && (
        <Box sx={{ fontFamily: mono, fontSize: 12, bgcolor: 'background.default', p: 1, borderRadius: 1, mb: 1, whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>
          {r.toolName}: {JSON.stringify(r.toolInput, null, 2)}
        </Box>
      )}
      <Stack spacing={2}>
        {r.questions.map((q) => (
          <Box key={q.question}>
            <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5, whiteSpace: 'pre-wrap' }}>
              {q.question}
            </Typography>
            {q.multiSelect ? (
              <Stack>
                {q.options.map((o) => {
                  const selected = (answers[q.question] || '').split(', ').filter(Boolean);
                  const checked = selected.includes(o.label);
                  return (
                    <FormControlLabel
                      key={o.label}
                      control={<Checkbox size="small" checked={checked} onChange={(e) => setAnswers((a) => ({ ...a, [q.question]: (e.target.checked ? [...selected, o.label] : selected.filter((x) => x !== o.label)).join(', ') }))} />}
                      label={<span>{o.label}{o.description ? <Typography component="span" variant="caption" color="text.secondary"> — {o.description}</Typography> : null}</span>}
                    />
                  );
                })}
              </Stack>
            ) : (
              <RadioGroup value={answers[q.question] || ''} onChange={(e) => setAnswers((a) => ({ ...a, [q.question]: e.target.value }))}>
                {q.options.map((o) => (
                  <FormControlLabel key={o.label} value={o.label} control={<Radio size="small" />} label={<span>{o.label}{o.description ? <Typography component="span" variant="caption" color="text.secondary"> — {o.description}</Typography> : null}</span>} />
                ))}
              </RadioGroup>
            )}
            {r.kind === 'question' && <TextField fullWidth placeholder="Or type your own answer…" value={free[q.question] || ''} onChange={(e) => setFree((f) => ({ ...f, [q.question]: e.target.value }))} multiline minRows={1} sx={{ mt: 1 }} />}
          </Box>
        ))}
      </Stack>
      <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
        <Button variant="contained" disabled={!ready || answer.isPending} onClick={submit}>
          Send answer
        </Button>
        <Button color="inherit" onClick={() => dismiss.mutate()} disabled={dismiss.isPending}>
          Dismiss
        </Button>
        {answer.isError && <Typography color="error" variant="caption">{String((answer.error as Error).message)}</Typography>}
      </Box>
    </Paper>
  );
}

export function RequestsPage() {
  const pending = useQuery({ queryKey: ['requests', 'pending'], queryFn: () => api.get<HumanRequest[]>('/api/requests?status=pending') });
  const history = useQuery({ queryKey: ['requests', 'all'], queryFn: () => api.get<HumanRequest[]>('/api/requests') });
  const past = (history.data || []).filter((r) => r.status !== 'pending').slice(0, 20);
  return (
    <Stack spacing={2} sx={{ maxWidth: 900 }}>
      <Typography variant="h6">Pending requests {pending.data?.length ? `(${pending.data.length})` : ''}</Typography>
      {pending.data?.length === 0 && (
        <Typography color="text.secondary">Nothing waiting on you. Agents post here when they need a decision or a permission; the card on the board gets an orange badge at the same time.</Typography>
      )}
      {pending.data?.map((r) => <RequestCard key={r.id} r={r} />)}
      {past.length > 0 && (
        <>
          <Typography variant="subtitle2" color="text.secondary" sx={{ pt: 2 }}>
            Recently answered
          </Typography>
          {past.map((r) => (
            <Paper key={r.id} variant="outlined" sx={{ p: 1.5, opacity: 0.8 }}>
              <Typography variant="body2">
                <b>{r.cardKey || r.cardTitle}</b> · {r.questions.map((q) => q.question).join(' | ')}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {r.status === 'answered' ? `Answered: ${Object.values(r.answers || {}).join(' | ')}` : 'Dismissed'} · {timeAgo(r.answeredAt)}
              </Typography>
            </Paper>
          ))}
        </>
      )}
    </Stack>
  );
}
