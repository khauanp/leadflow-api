/* =====================================================================
   LeadFlow API — versão Supabase (Postgres + Supabase Auth)
   Mantém os mesmos endpoints e formatos JSON do protótipo SQLite.
   ===================================================================== */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('fs');
const { createClient } = require('@supabase/supabase-js');

// Node 20 não tem WebSocket nativo; o SDK do Supabase exige um polyfill mesmo sem usar realtime.
try { global.WebSocket = global.WebSocket || require('ws'); } catch (_) {}

const PORT = process.env.PORT || 8000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Faltam SUPABASE_URL / SUPABASE_SERVICE_KEY no .env');
  process.exit(1);
}

// cliente server-side com service_role (bypassa RLS — filtramos por company_id no app)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
// cliente separado para Auth (signIn/getUser) — evita poluir o service_role com session de usuário
const authClient = createClient(SUPABASE_URL, process.env.SUPABASE_ANON_KEY || SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const app = express();
app.use(cors());
app.use(express.json());

/* ---------- helpers ---------- */
async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}
function money(n) { return Number(n || 0); }
function isoMinusMinutes(m) { return new Date(Date.now() - m * 60000).toISOString(); }
function todayStartISO() { return new Date().toISOString().slice(0, 10); }

function flattenLead(l) {
  if (!l) return l;
  return {
    ...l,
    source_name: l.source ? l.source.name : null,
    stage_name: l.stage ? l.stage.name : null,
    stage_position: l.stage ? l.stage.position : null,
    is_won: l.stage ? !!l.stage.is_won : false,
    is_lost: l.stage ? !!l.stage.is_lost : false,
    assigned_name: l.assignee ? l.assignee.name : null,
    business_name: l.__settings_name || null,
  };
}
const LEAD_SELECT = '*, source:lead_sources(name), stage:pipeline_stages(id,name,position,is_won,is_lost), assignee:users(name)';

/* ---------- Auth middleware (Supabase Auth) ---------- */
async function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Sem token' });
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: 'Token inválido' });
    const { data: urow, error: ue } = await supabase.from('users')
      .select('id, company_id, name, email, role').eq('id', data.user.id).single();
    if (ue || !urow) return res.status(403).json({ error: 'Usuário sem empresa vinculada' });
    req.user = urow;
    // trava de trial/assinatura (libera rotas de cobrança mesmo vencida)
    const bypass = ['/api/me', '/api/subscription', '/api/checkout', '/api/plans'];
    if (!bypass.includes(req.path)) {
      const comp = await q(supabase.from('companies').select('plan, trial_ends_at').eq('id', urow.company_id).maybeSingle());
      if (!comp) return res.status(403).json({ error: 'Empresa não encontrada' });
      const active = comp.plan !== 'trial' || (comp.trial_ends_at && new Date(comp.trial_ends_at) > new Date());
      if (!active) return res.status(402).json({ error: 'trial_expired', plan: comp.plan });
    }
    next();
  } catch (e) { res.status(401).json({ error: 'Falha na autenticação: ' + e.message }); }
}

/* ---------- Planos / Mercado Pago PIX ---------- */
const PLANS = {
  essencial:     { id: 'essencial',     name: 'Essencial',     price: 97,  features: ['1 unidade', 'Inbox + Pipeline', 'Auto-respostas', 'Dashboard financeiro'] },
  profissional:  { id: 'profissional', name: 'Profissional',  price: 197, features: ['Tudo do Essencial', 'Regras de roteamento', 'Multi-atendentes', 'Relatórios avançados'] },
  multi:         { id: 'multi',        name: 'Multi-unidade', price: 397, features: ['Tudo do Profissional', 'Unidades ilimitadas', 'Permissões por unidade', 'Suporte prioritário'] },
};
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_API = 'https://api.mercadopago.com';
let WEBHOOK_URL = process.env.MP_WEBHOOK_URL || ''; // preenchido após publish

app.get('/api/plans', (_req, res) => res.json(Object.values(PLANS)));

app.get('/api/subscription', auth, async (req, res) => {
  try {
    const comp = await q(supabase.from('companies').select('plan, trial_ends_at').eq('id', req.user.company_id).maybeSingle());
    const now = new Date();
    const trialEndsAt = comp.trial_ends_at ? new Date(comp.trial_ends_at) : null;
    const active = comp.plan !== 'trial' || (trialEndsAt && trialEndsAt > now);
    const daysLeft = trialEndsAt ? Math.max(0, Math.ceil((trialEndsAt - now) / 86400000)) : null;
    res.json({ plan: comp.plan, trial_ends_at: comp.trial_ends_at, active, daysLeft, isTrial: comp.plan === 'trial' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/checkout', auth, async (req, res) => {
  try {
    if (!MP_TOKEN) return res.status(500).json({ error: 'Mercado Pago não configurado' });
    const plan = PLANS[(req.body || {}).plan];
    if (!plan) return res.status(422).json({ error: 'Plano inválido' });
    const cid = req.user.company_id;
    const payload = {
      transaction_amount: plan.price,
      description: 'LeadFlow ' + plan.name + ' — assinatura mensal',
      payment_method_id: 'pix',
      payer: { email: req.user.email, first_name: (req.user.name || '').split(' ')[0] },
      metadata: { company_id: cid, plan: plan.id, user_id: req.user.id },
      notification_url: WEBHOOK_URL || undefined,
      date_of_expiration: new Date(Date.now() + 30 * 60000).toISOString(),
    };
    const r = await fetch(MP_API + '/v1/payments', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + MP_TOKEN, 'Content-Type': 'application/json', 'X-Idempotency-Key': cid + '-' + plan.id + '-' + Date.now() },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok || data.status === 'rejected') return res.status(502).json({ error: (data && data.message) || 'Erro ao gerar PIX', detail: data });
    const td = data.point_of_interaction && data.point_of_interaction.transaction_data || {};
    res.status(201).json({
      payment_id: data.id, status: data.status,
      qr_code: td.qr_code, qr_code_base64: td.qr_code_base64,
      ticket_url: td.ticket_url, plan: plan.id, price: plan.price,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Webhook público do Mercado Pago (sem auth). Ativa o plano ao confirmar pagamento.
app.post('/api/mp/webhook', async (req, res) => {
  try {
    const body = req.body || {};
    const pid = body.data && body.data.id || body.payment_id || body.id;
    if (!pid) return res.status(200).json({ ok: true });
    if (!MP_TOKEN) return res.status(200).json({ ok: true });
    const r = await fetch(MP_API + '/v1/payments/' + pid, { headers: { Authorization: 'Bearer ' + MP_TOKEN } });
    const pay = await r.json();
    if (pay.status === 'approved' && pay.metadata && pay.metadata.company_id) {
      const cid = pay.metadata.company_id;
      const plan = pay.metadata.plan;
      await q(supabase.from('companies').update({ plan, trial_ends_at: new Date(Date.now() + 31 * 86400000).toISOString() }).eq('id', cid));
    }
    res.status(200).json({ ok: true });
  } catch (e) { res.status(200).json({ ok: true }); }
});

/* ---------- Template / auto-reply ---------- */
function renderTemplate(tpl, lead) {
  const first = (lead.name || '').split(' ')[0] || '';
  return (tpl || '')
    .replace(/\{nome\}/g, first)
    .replace(/\{interesse\}/g, lead.interest || '')
    .replace(/\{empresa\}/g, lead.business_name || '')
    .replace(/\{telefone\}/g, lead.phone || '');
}
async function runAutoReplies(lead, cid) {
  const rules = await q(supabase.from('auto_replies').select('*, source:lead_sources(name)')
    .eq('company_id', cid).eq('active', true).eq('trigger_type', 'on_new_lead')
    .order('id'));
  if (!rules.length) return null;
  const match = rules.find((r) => r.source_id && r.source_id === lead.source_id)
    || rules.find((r) => !r.source_id);
  if (!match) return null;
  const settings = await q(supabase.from('company_settings').select('business_name').eq('company_id', cid).single());
  const body = renderTemplate(match.message_text, { ...lead, business_name: settings.business_name });
  await q(supabase.from('messages').insert({ lead_id: lead.id, direction: 'out', body, auto: true }));
  if (!lead.first_response_at) {
    await q(supabase.from('leads').update({ first_response_at: new Date().toISOString() }).eq('id', lead.id));
  }
  await q(supabase.from('lead_events').insert({ lead_id: lead.id, event_type: 'auto_reply_sent', meta: { rule_id: match.id, rule_name: match.name } }));
  return body;
}

/* ===================================================================== */
/*  Bootstrap do usuário master + dados de demo (idempotente)            */
/* ===================================================================== */
const MASTER_EMAIL = 'khauanp22@gmail.com';
const MASTER_PASSWORD = 'LeadMaster@2026';
async function bootstrapMaster() {
  const existing = await q(supabase.from('users').select('id, company_id').eq('email', MASTER_EMAIL).maybeSingle());
  let cid;
  if (existing) { cid = existing.company_id; }
  else {
    const { data, error } = await supabase.auth.admin.createUser({
      email: MASTER_EMAIL, password: MASTER_PASSWORD, email_confirm: true,
      user_metadata: { name: 'Khauan Pedroso', business_name: 'Clínica Bem-Estar' },
    });
    if (error) { console.error('bootstrap createUser:', JSON.stringify(error)); return; }
    const u = await q(supabase.from('users').select('id, company_id').eq('id', data.user.id).single());
    cid = u.company_id;
    console.log('✓ Usuário master criado via Supabase Auth');
  }
  // master = plano multi, trial infinito
  await supabase.from('companies').update({ plan: 'multi', trial_ends_at: new Date(Date.now() + 100 * 365 * 86400000).toISOString() }).eq('id', cid).then(r => r);
  await seedDemo(cid);
}
async function seedDemo(cid) {
  const { count } = await supabase.from('leads').select('id', { count: 'exact', head: true }).eq('company_id', cid);
  if (count && count > 0) return; // já tem leads — não semeia de novo
  const stages = await q(supabase.from('pipeline_stages').select('id,name,position,is_won,is_lost').eq('company_id', cid).order('position'));
  const byName = {}; stages.forEach(s => byName[s.name] = s);
  const sources = await q(supabase.from('lead_sources').select('id,name').eq('company_id', cid));
  const src = {}; sources.forEach(s => src[s.name] = s.id);
  const mins = (m) => isoMinusMinutes(m);
  const rows = [
    ['Mariana Lopes', 'Instagram', '(41) 98888-1100', 'Harmonização facial', 8500, byName['Fechado'].id, mins(180), mins(200)],
    ['Rafael Tavares', 'Google Ads', '(41) 97777-2200', 'Botox', 3200, byName['Novo'].id, null, mins(6)],
    ['Carlos Henrique', 'WhatsApp', '(41) 96666-3300', 'Limpeza de pele', 620, byName['Novo'].id, null, mins(22)],
    ['Patrícia Nunes', 'Instagram', '(41) 95555-4400', 'Preenchimento', 4800, byName['Em contato'].id, mins(71), mins(75)],
    ['Juliana Prado', 'Indicação', '(41) 94444-5500', 'Pacote estético', 15000, byName['Visita agendada'].id, mins(85), mins(90)],
    ['Bruno Almeida', 'Site', '(41) 93333-6600', 'Consulta inicial', 980, byName['Em contato'].id, mins(116), mins(120)],
    ['Fernanda Dias', 'Indicação', '(41) 92222-7700', 'Tratamento completo', 18000, byName['Fechado'].id, mins(196), mins(200)],
    ['Diego Martins', 'WhatsApp', '(41) 91111-8800', 'Massagem modeladora', 1200, byName['Novo'].id, null, mins(40)],
    ['Camila Rocha', 'Google Ads', '(41) 90000-9900', 'Drenagem linfática', 900, byName['Em contato'].id, mins(146), mins(150)],
  ];
  const toInsert = rows.map(([name, sname, phone, interest, val, stageId, fr, created]) => ({
    company_id: cid, source_id: src[sname] || null, name, phone,
    email: name.toLowerCase().replace(/[^a-z]/g, '') + '@mail.com',
    interest, region: 'Curitiba', estimated_value: val, stage_id: stageId,
    assigned_user_id: null, status: byName[sname] && byName[sname] ? 'aberto' : 'aberto',
    first_response_at: fr, created_at: created, updated_at: created,
  }));
  const inserted = await q(supabase.from('leads').insert(toInsert).select('id,name,source_id'));
  for (const l of inserted) {
    await supabase.from('lead_events').insert({ lead_id: l.id, event_type: 'lead_received', meta: { source: rows.find(r => r[0] === l.name)?.[1] } });
  }
  console.log('✓ Dados de demo inseridos (' + inserted.length + ' leads)');
}

/* ===================================================================== */
/*  Routes                                                               */
/* ===================================================================== */
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(422).json({ error: 'Email e senha obrigatórios' });
    const { data, error } = await authClient.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: 'Credenciais inválidas' });
    const urow = await q(supabase.from('users').select('id, company_id, name, email, role').eq('id', data.user.id).single());
    res.json({ token: data.session.access_token, user: urow });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, name, business_name } = req.body || {};
    if (!email || !password) return res.status(422).json({ error: 'Email e senha obrigatórios' });
    const { data, error } = await authClient.auth.signUp({
      email, password,
      options: { data: { name: name || email.split('@')[0], business_name: business_name || 'Minha empresa' } },
    });
    if (error) return res.status(400).json({ error: error.message });
    if (!data.session) return res.status(200).json({ requires_confirmation: true, email });
    const urow = await q(supabase.from('users').select('id, company_id, name, email, role').eq('id', data.user.id).single());
    res.json({ token: data.session.access_token, user: urow });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me', auth, (req, res) => res.json(req.user));

app.get('/api/stages', auth, async (req, res) => {
  try { res.json(await q(supabase.from('pipeline_stages').select('*').eq('company_id', req.user.company_id).order('position'))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/sources', auth, async (req, res) => {
  try { res.json(await q(supabase.from('lead_sources').select('*').eq('company_id', req.user.company_id))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/users', auth, async (req, res) => {
  try { res.json(await q(supabase.from('users').select('id, name, email, role').eq('company_id', req.user.company_id))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const settings = (await q(supabase.from('company_settings').select('*').eq('company_id', cid).maybeSingle())) || { response_sla_min: 15, default_lead_value: 0, business_name: null };
    const sla = settings.response_sla_min || 15;
    const leads = await q(supabase.from('leads').select(LEAD_SELECT).eq('company_id', cid));
    const flat = leads.map(flattenLead).map(l => ({ ...l, business_name: settings.business_name }));
    const today = todayStartISO();
    const now = Date.now();
    const receivedToday = flat.filter(l => (l.created_at || '').slice(0, 10) === today).length;
    const total = flat.length;
    const won = flat.filter(l => l.is_won).length;
    const lost = flat.filter(l => l.is_lost).length;
    const withoutResponse = flat.filter(l => !l.first_response_at && !l.is_lost);
    const atRisk = withoutResponse.filter(l => new Date(l.created_at).getTime() <= now - sla * 60000);
    const stalledValue = withoutResponse.reduce((s, l) => s + money(l.estimated_value), 0);
    const lostTodayValue = flat.filter(l => l.is_lost && (l.updated_at || '').slice(0, 10) === today).reduce((s, l) => s + money(l.estimated_value), 0);
    const openValue = flat.filter(l => !l.is_won && !l.is_lost).reduce((s, l) => s + money(l.estimated_value), 0);
    const respTimes = flat.filter(l => l.first_response_at).map(l => (new Date(l.first_response_at) - new Date(l.created_at)) / 60000);
    const avgResponseMin = respTimes.length ? Math.round(respTimes.reduce((a, b) => a + b, 0) / respTimes.length) : null;
    const lostLeads = withoutResponse.map(l => ({
      id: l.id, name: l.name, phone: l.phone, interest: l.interest, estimated_value: money(l.estimated_value),
      created_at: l.created_at, source_name: l.source_name, minutes_waiting: Math.round((now - new Date(l.created_at)) / 60000),
    })).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).slice(0, 12);
    const lostToday = flat.filter(l => l.is_lost && (l.updated_at || '').slice(0, 10) === today).map(l => ({
      id: l.id, name: l.name, interest: l.interest, estimated_value: money(l.estimated_value),
      lost_reason: l.lost_reason, updated_at: l.updated_at, source_name: l.source_name,
    })).slice(0, 12);
    const byMap = {};
    flat.forEach(l => { const k = l.source_name || '—'; if (!byMap[k]) byMap[k] = { name: k, total: 0, won: 0, value: 0 }; byMap[k].total++; if (l.is_won) { byMap[k].won++; byMap[k].value += money(l.estimated_value); } });
    const bySource = Object.values(byMap).sort((a, b) => b.total - a.total);
    res.json({
      settings: { response_sla_min: sla, default_lead_value: settings.default_lead_value || 0, business_name: settings.business_name },
      kpis: { receivedToday, total, won, lost, withoutResponse: withoutResponse.length, atRisk: atRisk.length,
        conversionRate: total ? Math.round((won / total) * 100) : 0, avgResponseMin,
        stalledValue, lostTodayValue, openValue },
      lostLeads, lostToday, bySource,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leads', auth, async (req, res) => {
  try {
    const cid = req.user.company_id;
    let query = supabase.from('leads').select(LEAD_SELECT).eq('company_id', cid);
    if (req.query.stage) query = query.eq('stage_id', req.query.stage);
    if (req.query.source) query = query.eq('source_id', req.query.source);
    if (req.query.q) query = query.or(`name.ilike.%${req.query.q}%,phone.ilike.%${req.query.q}%,email.ilike.%${req.query.q}%`);
    const rows = await q(query.order('created_at', { ascending: false }));
    res.json(rows.map(flattenLead));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leads/:id', auth, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const lead = await q(supabase.from('leads').select(LEAD_SELECT).eq('id', req.params.id).eq('company_id', cid).maybeSingle());
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    const events = await q(supabase.from('lead_events').select('*').eq('lead_id', lead.id).order('created_at'));
    res.json({ ...flattenLead(lead), events });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leads', auth, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const { name, phone, email, interest, region, source_id, estimated_value } = req.body || {};
    if (!name && !phone) return res.status(422).json({ error: 'Nome ou telefone obrigatório' });
    const novo = await q(supabase.from('pipeline_stages').select('id').eq('company_id', cid).order('position').limit(1).single());
    // routing
    const rules = await q(supabase.from('routing_rules').select('*').eq('company_id', cid).eq('active', true).order('priority'));
    let assigned = null, stageId = novo.id;
    const srcName = source_id ? (await q(supabase.from('lead_sources').select('name').eq('id', source_id).maybeSingle()))?.name : '';
    for (const r of rules) {
      const fv = r.field === 'source' ? srcName : '';
      if (r.match === 'equals' && fv && fv.toLowerCase() === (r.value || '').toLowerCase()) {
        assigned = r.assign_to; if (r.target_stage_id) stageId = r.target_stage_id; break;
      }
    }
    const inserted = await q(supabase.from('leads').insert({
      company_id: cid, source_id: source_id || null, name: name || '', phone: phone || null,
      email: email || null, interest: interest || null, region: region || null,
      estimated_value: estimated_value || 0, stage_id: stageId, assigned_user_id: assigned, status: 'aberto',
    }).select(LEAD_SELECT).single());
    const lead = flattenLead(inserted);
    await q(supabase.from('lead_events').insert({ lead_id: lead.id, event_type: 'lead_received', meta: { source: srcName } }));
    if (assigned) await q(supabase.from('lead_events').insert({ lead_id: lead.id, event_type: 'lead_assigned', meta: { user_id: assigned } }));
    const autoBody = await runAutoReplies(lead, cid);
    res.status(201).json({ ...lead, auto_reply_sent: !!autoBody, auto_reply_body: autoBody });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leads/:id/move-stage', auth, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const { stage_id, lost_reason } = req.body || {};
    const lead = await q(supabase.from('leads').select('id,stage_id,first_response_at').eq('id', req.params.id).eq('company_id', cid).maybeSingle());
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    const stage = await q(supabase.from('pipeline_stages').select('id,position,is_won,is_lost').eq('id', stage_id).eq('company_id', cid).maybeSingle());
    if (!stage) return res.status(422).json({ error: 'Etapa inválida' });
    const status = stage.is_won ? 'ganho' : stage.is_lost ? 'perdido' : 'aberto';
    const patch = { stage_id, status, lost_reason: stage.is_lost ? (lost_reason || 'Não informado') : null, updated_at: new Date().toISOString() };
    if (!lead.first_response_at && stage.position > 0) patch.first_response_at = new Date().toISOString();
    await q(supabase.from('leads').update(patch).eq('id', lead.id));
    await q(supabase.from('lead_events').insert({ lead_id: lead.id, event_type: 'lead_status_changed', meta: { stage_id, status, lost_reason } }));
    const fresh = await q(supabase.from('leads').select(LEAD_SELECT).eq('id', lead.id).single());
    res.json(flattenLead(fresh));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/leads/:id', auth, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const lead = await q(supabase.from('leads').select('id,first_response_at').eq('id', req.params.id).eq('company_id', cid).maybeSingle());
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    const b = req.body || {};
    const patch = {};
    if (b.assigned_user_id !== undefined) patch.assigned_user_id = b.assigned_user_id || null;
    if (b.interest !== undefined) patch.interest = b.interest || null;
    if (b.estimated_value !== undefined) patch.estimated_value = Number(b.estimated_value) || 0;
    if (b.region !== undefined) patch.region = b.region || null;
    if (b.phone !== undefined) patch.phone = b.phone || null;
    if (b.email !== undefined) patch.email = b.email || null;
    if (b.first_response) patch.first_response_at = new Date().toISOString();
    patch.updated_at = new Date().toISOString();
    await q(supabase.from('leads').update(patch).eq('id', lead.id));
    const fresh = await q(supabase.from('leads').select(LEAD_SELECT).eq('id', lead.id).single());
    res.json(flattenLead(fresh));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rules', auth, async (req, res) => {
  try { res.json(await q(supabase.from('routing_rules').select('*, assign:users!assign_to(name)').eq('company_id', req.user.company_id).order('priority'))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/rules', auth, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const { name, priority, field, match, value, assign_to, target_stage_id } = req.body || {};
    if (!name || !field || !value) return res.status(422).json({ error: 'Nome, campo e valor obrigatórios' });
    const r = await q(supabase.from('routing_rules').insert({
      company_id: cid, name, priority: priority || 10, active: true, field, match: match || 'equals', value,
      assign_to: assign_to || null, target_stage_id: target_stage_id || null,
    }).select('*').single());
    res.status(201).json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/rules/:id', auth, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const r = await q(supabase.from('routing_rules').select('*').eq('id', req.params.id).eq('company_id', cid).maybeSingle());
    if (!r) return res.status(404).json({ error: 'Regra não encontrada' });
    const b = req.body || {};
    const patch = {};
    ['name', 'priority', 'field', 'match', 'value', 'assign_to', 'target_stage_id'].forEach(k => { if (b[k] !== undefined) patch[k] = b[k]; });
    if (b.active !== undefined) patch.active = !!b.active;
    await q(supabase.from('routing_rules').update(patch).eq('id', r.id));
    res.json(await q(supabase.from('routing_rules').select('*').eq('id', r.id).single()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pipeline', auth, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const stages = await q(supabase.from('pipeline_stages').select('*').eq('company_id', cid).order('position'));
    const leads = await q(supabase.from('leads').select(LEAD_SELECT).eq('company_id', cid));
    res.json(stages.map(st => ({
      ...st, is_won: !!st.is_won, is_lost: !!st.is_lost,
      leads: leads.filter(l => l.stage && l.stage.id === st.id).map(flattenLead),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- Settings ---------- */
app.get('/api/settings', auth, async (req, res) => {
  try {
    const s = await q(supabase.from('company_settings').select('*').eq('company_id', req.user.company_id).maybeSingle());
    res.json(s || { response_sla_min: 15, default_lead_value: 0, business_name: null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/settings', auth, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const { business_name, segment, response_sla_min, default_lead_value } = req.body || {};
    const payload = { company_id: cid, business_name, segment, response_sla_min: Number(response_sla_min) || 15, default_lead_value: Number(default_lead_value) || 0 };
    const existing = await q(supabase.from('company_settings').select('company_id').eq('company_id', cid).maybeSingle());
    let s;
    if (existing) s = await q(supabase.from('company_settings').update(payload).eq('company_id', cid).select('*').single());
    else s = await q(supabase.from('company_settings').insert(payload).select('*').single());
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- Stages CRUD ---------- */
app.post('/api/stages', auth, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const { name, is_won, is_lost } = req.body || {};
    const max = await q(supabase.from('pipeline_stages').select('position').eq('company_id', cid).order('position', { ascending: false }).limit(1).maybeSingle());
    const pos = (max?.position ?? -1) + 1;
    const s = await q(supabase.from('pipeline_stages').insert({ company_id: cid, name, position: pos, is_won: !!is_won, is_lost: !!is_lost }).select('*').single());
    res.status(201).json({ ...s, is_won: !!s.is_won, is_lost: !!s.is_lost });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/stages/:id', auth, async (req, res) => {
  try {
    const cid = req.user.company_id;
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.is_won !== undefined) patch.is_won = !!b.is_won;
    if (b.is_lost !== undefined) patch.is_lost = !!b.is_lost;
    await q(supabase.from('pipeline_stages').update(patch).eq('id', req.params.id).eq('company_id', cid));
    const s = await q(supabase.from('pipeline_stages').select('*').eq('id', req.params.id).single());
    res.json({ ...s, is_won: !!s.is_won, is_lost: !!s.is_lost });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/stages/:id', auth, async (req, res) => {
  try {
    await q(supabase.from('pipeline_stages').delete().eq('id', req.params.id).eq('company_id', req.user.company_id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- Sources CRUD ---------- */
app.post('/api/sources', auth, async (req, res) => {
  try {
    const s = await q(supabase.from('lead_sources').insert({ company_id: req.user.company_id, name: req.body.name, type: req.body.type || 'form' }).select('*').single());
    res.status(201).json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/sources/:id', auth, async (req, res) => {
  try {
    await q(supabase.from('lead_sources').delete().eq('id', req.params.id).eq('company_id', req.user.company_id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- Channels ---------- */
app.get('/api/channels', auth, async (req, res) => {
  try { res.json(await q(supabase.from('channels').select('*').eq('company_id', req.user.company_id))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/channels', auth, async (req, res) => {
  try {
    const token = require('crypto').randomBytes(8).toString('hex');
    const c = await q(supabase.from('channels').insert({
      company_id: req.user.company_id, name: req.body.name, type: req.body.type || 'whatsapp',
      phone: req.body.phone || null, status: 'connected', webhook_token: token, connected_at: new Date().toISOString(),
    }).select('*').single());
    res.status(201).json(c);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/channels/:id', auth, async (req, res) => {
  try {
    const patch = {};
    if (req.body.status !== undefined) patch.status = req.body.status;
    if (req.body.name !== undefined) patch.name = req.body.name;
    await q(supabase.from('channels').update(patch).eq('id', req.params.id).eq('company_id', req.user.company_id));
    res.json(await q(supabase.from('channels').select('*').eq('id', req.params.id).single()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/channels/:id', auth, async (req, res) => {
  try {
    await q(supabase.from('channels').delete().eq('id', req.params.id).eq('company_id', req.user.company_id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- Auto-replies ---------- */
app.get('/api/auto-replies', auth, async (req, res) => {
  try { res.json(await q(supabase.from('auto_replies').select('*, source:lead_sources(name)').eq('company_id', req.user.company_id).order('id'))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/auto-replies', auth, async (req, res) => {
  try {
    const a = await q(supabase.from('auto_replies').insert({
      company_id: req.user.company_id, name: req.body.name, trigger_type: req.body.trigger_type || 'on_new_lead',
      wait_minutes: req.body.wait_minutes || 0, message_text: req.body.message_text,
      active: req.body.active !== false, source_id: req.body.source_id || null,
    }).select('*, source:lead_sources(name)').single());
    res.status(201).json(a);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/auto-replies/:id', auth, async (req, res) => {
  try {
    const patch = {};
    if (req.body.active !== undefined) patch.active = !!req.body.active;
    if (req.body.name !== undefined) patch.name = req.body.name;
    if (req.body.message_text !== undefined) patch.message_text = req.body.message_text;
    if (req.body.source_id !== undefined) patch.source_id = req.body.source_id || null;
    await q(supabase.from('auto_replies').update(patch).eq('id', req.params.id).eq('company_id', req.user.company_id));
    res.json(await q(supabase.from('auto-replies').select('*, source:lead_sources(name)').eq('id', req.params.id).single()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/auto-replies/:id', auth, async (req, res) => {
  try {
    await q(supabase.from('auto_replies').delete().eq('id', req.params.id).eq('company_id', req.user.company_id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- Messages ---------- */
app.get('/api/leads/:id/messages', auth, async (req, res) => {
  try {
    const lead = await q(supabase.from('leads').select('id').eq('id', req.params.id).eq('company_id', req.user.company_id).maybeSingle());
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    res.json(await q(supabase.from('messages').select('*').eq('lead_id', lead.id).order('created_at')));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/leads/:id/messages', auth, async (req, res) => {
  try {
    const lead = await q(supabase.from('leads').select('id,first_response_at').eq('id', req.params.id).eq('company_id', req.user.company_id).maybeSingle());
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    const body = (req.body.body || '').trim();
    if (!body) return res.status(422).json({ error: 'Mensagem vazia' });
    const m = await q(supabase.from('messages').insert({ lead_id: lead.id, direction: 'out', body, auto: false }).select('*').single());
    if (!lead.first_response_at) await q(supabase.from('leads').update({ first_response_at: new Date().toISOString() }).eq('id', lead.id));
    await q(supabase.from('lead_events').insert({ lead_id: lead.id, event_type: 'manual_message', meta: {} }));
    res.status(201).json(m);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Erro interno' }); });

// Exporta o app Express para a Vercel (serverless). 
// O app.listen só roda fora da Vercel (dev/local).
module.exports = app;
module.exports.app = app;
module.exports.bootstrapMaster = bootstrapMaster;

if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`LeadFlow API (Supabase) listening on ${PORT}`);
    bootstrapMaster().catch(e => console.error('bootstrap:', e.message));
  });
}
