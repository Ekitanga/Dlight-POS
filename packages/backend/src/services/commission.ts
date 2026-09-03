import { query, transaction } from '../db/index.js'
import { logAudit } from '../utils/audit.js'

export interface DbExecutor {
  query: (text: string, params?: any[]) => Promise<any>
}

const defaultExecutor: DbExecutor = { query }

function executorOrDefault(executor?: DbExecutor): DbExecutor {
  return executor || defaultExecutor
}

async function withExecutorTransaction<T>(executor: DbExecutor | undefined, callback: (client: DbExecutor) => Promise<T>): Promise<T> {
  if (executor) return callback(executor)
  return transaction(callback)
}

function toNumber(value: unknown): number {
  const numberValue = Number(value || 0)
  return Number.isFinite(numberValue) ? numberValue : 0
}

export interface CommissionProgramme {
  id: string
  status: string
  effective_from: string
  effective_to: string | null
  reason: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface CommissionRate {
  id: string
  programme_id: string
  rate_per_item: number
  effective_from: string
  effective_to: string | null
  scope_type: string
  scope_id: string | null
  scope_name: string | null
  created_by: string | null
  created_at: string
}

export interface CommissionEligibility {
  id: string
  programme_id: string
  scope_type: string
  scope_id: string
  scope_name: string
  is_eligible: boolean
  effective_from: string
  effective_to: string | null
  created_by: string | null
  created_at: string
}

export async function getActiveProgramme(): Promise<CommissionProgramme | null> {
  return getProgrammeAsOf(new Date().toISOString())
}

const INITIAL_PROGRAMME_PLACEHOLDER_REASON =
  'Initial KSh 50 commission configuration; activate only after management review.'

export async function isCommissionModuleEnabled(executor?: DbExecutor): Promise<boolean> {
  const result = await executorOrDefault(executor).query(
    'SELECT commission_module_enabled FROM settings ORDER BY id DESC LIMIT 1'
  )
  return result.rows[0]?.commission_module_enabled !== false
}

function nairobiDate(value: string | Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(value))
  const component = (type: string) => parts.find(part => part.type === type)?.value
  return `${component('year')}-${component('month')}-${component('day')}`
}

/**
 * Policy dates are stored as timestamp-without-time-zone values. Treat them as
 * Africa/Nairobi business time so an ISO event near midnight cannot move a
 * commission programme, rate, or eligibility rule into the wrong period.
 */
function nairobiTimestamp(value: string | Date): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('Invalid commission timestamp')
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date)
  const component = (type: string) => parts.find(part => part.type === type)?.value
  return `${component('year')}-${component('month')}-${component('day')} ${component('hour')}:${component('minute')}:${component('second')}.${String(date.getUTCMilliseconds()).padStart(3, '0')}`
}

function normalizeNairobiTimestamp(value: string | Date, endOfBusinessDay = false): string {
  if (value instanceof Date) return nairobiTimestamp(value)
  const raw = String(value || '').trim()
  if (!raw) throw new Error('Invalid commission timestamp')
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw} ${endOfBusinessDay ? '23:59:59.999' : '00:00:00.000'}`
  }
  // datetime-local values have no offset and are deliberately entered as Nairobi time.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?$/.test(raw)) {
    return raw.replace('T', ' ')
  }
  return nairobiTimestamp(raw)
}

function requireProspectivePolicyTimestamp(normalizedTimestamp: string, label: string): string {
  const now = normalizeNairobiTimestamp(new Date())
  if (normalizedTimestamp >= now) return normalizedTimestamp
  const effectiveEpoch = Date.parse(`${normalizedTimestamp.replace(' ', 'T')}+03:00`)
  const nowEpoch = Date.parse(`${now.replace(' ', 'T')}+03:00`)
  // Browser datetime-local controls only have minute precision. Clamp a
  // just-submitted value to now, but reject actual historical policy edits.
  if (nowEpoch - effectiveEpoch <= 60_000) return now
  throw Object.assign(
    new Error(`${label} cannot be backdated because it could change historic commission. Use a reviewed manual adjustment instead.`),
    { statusCode: 400 }
  )
}

function latestTimestamp(candidates: Array<{ value: unknown; source: string }>): { timestamp: string; source: string } | null {
  const valid = candidates
    .map(candidate => ({ ...candidate, date: candidate.value ? new Date(candidate.value as any) : null }))
    .filter(candidate => candidate.date && !Number.isNaN(candidate.date.getTime())) as Array<{ value: unknown; source: string; date: Date }>
  valid.sort((a, b) => b.date.getTime() - a.date.getTime())
  return valid[0] ? { timestamp: valid[0].date.toISOString(), source: valid[0].source } : null
}

export async function getProgrammeStateAsOf(asOfDate: string, executor?: DbExecutor): Promise<CommissionProgramme | null> {
  const businessTimestamp = normalizeNairobiTimestamp(asOfDate)
  const result = await executorOrDefault(executor).query(
    `SELECT id, status, effective_from, effective_to, reason, created_by, created_at, updated_at
     FROM commission_programmes
     WHERE effective_from <= $1::timestamp
       AND (effective_to IS NULL OR effective_to >= $1::timestamp)
     ORDER BY effective_from DESC, created_at DESC, id DESC
     LIMIT 1`,
    [businessTimestamp]
  )
  return result.rows[0] || null
}

export async function getProgrammeAsOf(asOfDate: string, executor?: DbExecutor): Promise<CommissionProgramme | null> {
  const programme = await getProgrammeStateAsOf(asOfDate, executor)
  return programme?.status === 'active' ? programme : null
}

export async function getProgrammeHistory() {
  const result = await query(
    `SELECT id, status, effective_from, effective_to, reason, created_by, created_at, updated_at
     FROM commission_programmes
     ORDER BY effective_from DESC`
  )
  return result.rows
}

export async function updateProgrammeStatus(
  programmeId: string,
  status: string,
  effectiveFrom: string,
  effectiveTo: string | null,
  reason: string | null,
  userId: string | null,
  allowBackdate = false
): Promise<CommissionProgramme> {
  if (!['active', 'suspended', 'disabled'].includes(status)) {
    throw Object.assign(new Error('Programme status must be active, suspended, or disabled'), { statusCode: 400 })
  }
  if (!effectiveFrom || Number.isNaN(Date.parse(effectiveFrom))) {
    throw Object.assign(new Error('A valid effective date and time is required'), { statusCode: 400 })
  }
  if (effectiveTo && Date.parse(effectiveTo) < Date.parse(effectiveFrom)) {
    throw Object.assign(new Error('Effective end must not be before effective start'), { statusCode: 400 })
  }
  if (status !== 'active' && !String(reason || '').trim()) {
    throw Object.assign(new Error('A reason is required when suspending or disabling commission'), { statusCode: 400 })
  }

  let normalizedFrom = normalizeNairobiTimestamp(effectiveFrom)
  const normalizedTo = effectiveTo
    ? normalizeNairobiTimestamp(effectiveTo, /^\d{4}-\d{2}-\d{2}$/.test(effectiveTo))
    : null
  if (normalizedTo && normalizedTo < normalizedFrom) {
    throw Object.assign(new Error('Effective end must not be before effective start'), { statusCode: 400 })
  }
  const currentBusinessTimestamp = normalizeNairobiTimestamp(new Date())
  if (normalizedFrom < currentBusinessTimestamp && !allowBackdate) {
      // HTML datetime controls submit to the minute, so a just-selected "now"
      // can already be a few seconds old. Clamp that narrow UI tolerance to
      // the actual current time; anything older would silently backdate a
      // programme reactivation and is intentionally rejected.
      const effectiveEpoch = Date.parse(`${normalizedFrom.replace(' ', 'T')}+03:00`)
      const currentEpoch = Date.parse(`${currentBusinessTimestamp.replace(' ', 'T')}+03:00`)
      if (currentEpoch - effectiveEpoch > 60_000) {
        throw Object.assign(new Error('Programme policy changes cannot be backdated. Use an auditable manual adjustment for a historical correction.'), { statusCode: 400 })
      }
      normalizedFrom = currentBusinessTimestamp
  }
  if (normalizedFrom < currentBusinessTimestamp && allowBackdate && !String(reason || '').trim()) {
    throw Object.assign(new Error('A reason is required for a backdated programme change'), { statusCode: 400 })
  }

  return transaction(async client => {
    const previous = await getProgrammeStateAsOf(normalizedFrom, client)
    const result = await client.query(
      `INSERT INTO commission_programmes (status, effective_from, effective_to, reason, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       RETURNING id, status, effective_from, effective_to, reason, created_by, created_at, updated_at`,
      [status, normalizedFrom, normalizedTo, String(reason || '').trim() || null, userId]
    )
    const created = result.rows[0]
    // A status change is a new policy version. Copy the configuration that was
    // in force immediately before it so suspended/disabled settings can be
    // safely prepared and then reactivated without borrowing another version's
    // rates or eligibility rules.
    let sourceProgramme = await client.query(
      `SELECT id FROM commission_programmes
       WHERE id <> $1 AND effective_from <= $2::timestamp
       ORDER BY effective_from DESC
       LIMIT 1`,
      [created.id, normalizedFrom]
    )
    if (!sourceProgramme.rows[0] && allowBackdate) {
      sourceProgramme = await client.query(
        `SELECT cp.id
         FROM commission_programmes cp
         WHERE cp.id <> $1
           AND (
             EXISTS (
               SELECT 1 FROM commission_rates cr
               WHERE cr.programme_id = cp.id
                 AND cr.effective_from <= $2::timestamp
                 AND (cr.effective_to IS NULL OR cr.effective_to >= $2::timestamp)
             )
             OR EXISTS (
               SELECT 1 FROM commission_eligibility ce
               WHERE ce.programme_id = cp.id
                 AND ce.effective_from <= $2::timestamp
                 AND (ce.effective_to IS NULL OR ce.effective_to >= $2::timestamp)
             )
           )
         ORDER BY (cp.status = 'active') DESC, cp.effective_from DESC, cp.created_at DESC, cp.id DESC
         LIMIT 1`,
        [created.id, normalizedFrom]
      )
    }
    const sourceId = sourceProgramme.rows[0]?.id
    if (sourceId) {
      await client.query(
        `INSERT INTO commission_rates
           (programme_id, rate_per_item, effective_from, effective_to, scope_type, scope_id, scope_name, created_by, created_at)
         SELECT $1, rate_per_item, $3::timestamp, effective_to, scope_type, scope_id, scope_name, $4, NOW()
         FROM commission_rates
         WHERE programme_id = $2
           AND effective_from <= $3::timestamp
           AND (effective_to IS NULL OR effective_to >= $3::timestamp)`,
        [created.id, sourceId, normalizedFrom, userId]
      )
      await client.query(
        `INSERT INTO commission_eligibility
           (programme_id, scope_type, scope_id, scope_name, is_eligible, effective_from, effective_to, created_by, created_at)
         SELECT $1, scope_type, scope_id, scope_name, is_eligible, $3::timestamp, effective_to, $4, NOW()
         FROM commission_eligibility
         WHERE programme_id = $2
           AND effective_from <= $3::timestamp
           AND (effective_to IS NULL OR effective_to >= $3::timestamp)`,
        [created.id, sourceId, normalizedFrom, userId]
      )
    }
    if (status === 'active') {
      const rateCount = await client.query('SELECT COUNT(*)::int AS count FROM commission_rates WHERE programme_id = $1', [created.id])
      if (Number(rateCount.rows[0]?.count || 0) === 0) {
        throw Object.assign(new Error('Configure an explicit commission rate while the programme is disabled or suspended before activating it.'), { statusCode: 400 })
      }

      // A fresh installation includes a later-dated disabled placeholder. When
      // management backdates the first real activation, that placeholder must
      // not override the new policy once its original timestamp is reached.
      // Only the exact system-created placeholder is retired here; deliberate
      // suspensions and disablements remain part of the effective-date timeline.
      await client.query(
        `UPDATE commission_programmes placeholder
         SET effective_to = placeholder.effective_from, updated_at = NOW()
         WHERE placeholder.id <> $1
           AND placeholder.status = 'disabled'
           AND placeholder.created_by IS NULL
           AND placeholder.reason = $2
           AND placeholder.effective_from > $3::timestamp
           AND (placeholder.effective_to IS NULL OR placeholder.effective_to > placeholder.effective_from)`,
        [created.id, INITIAL_PROGRAMME_PLACEHOLDER_REASON, normalizedFrom]
      )
    }
    await logAudit({
      client,
      userId,
      action: `commission_programme_${status}`,
      entityType: 'commission_programme',
      entityId: programmeId || created.id,
      oldValues: previous ? { status: previous.status, effective_from: previous.effective_from } : null,
      newValues: { status, effective_from: normalizedFrom, effective_to: normalizedTo, reason }
    })
    return created
  })
}

export async function getRateForItem(programmeId: string, productId: string, categoryId: string | null, salespersonId: string, asOfDate?: string, executor?: DbExecutor): Promise<number> {
  const now = normalizeNairobiTimestamp(asOfDate || new Date().toISOString())
  const result = await executorOrDefault(executor).query(
    `SELECT rate_per_item
     FROM commission_rates
     WHERE programme_id = $5
       AND effective_from <= $4::timestamp
       AND (effective_to IS NULL OR effective_to >= $4::timestamp)
       AND (
         scope_type = 'global'
         OR (scope_type = 'product' AND scope_id = $1)
         OR (scope_type = 'category' AND scope_id = $2)
         OR (scope_type = 'salesperson' AND scope_id = $3)
       )
     ORDER BY CASE scope_type
       WHEN 'salesperson' THEN 1
       WHEN 'product' THEN 2
       WHEN 'category' THEN 3
       WHEN 'global' THEN 4
     END,
     effective_from DESC,
     created_at DESC
     LIMIT 1`,
    [productId, categoryId, salespersonId, now, programmeId]
  )
  return result.rows[0] ? toNumber(result.rows[0].rate_per_item) : 0
}

export async function setRate(
  programmeId: string,
  ratePerItem: number,
  scopeType: string,
  scopeId: string | null,
  scopeName: string | null,
  effectiveFrom: string,
  effectiveTo: string | null,
  userId: string | null,
  allowBackdate = false,
  replaceRateId: string | null = null
): Promise<CommissionRate> {
  if (!Number.isFinite(ratePerItem) || ratePerItem <= 0) {
    throw Object.assign(new Error('Commission rate must be greater than zero'), { statusCode: 400 })
  }
  if (!['global', 'category', 'product', 'salesperson'].includes(scopeType)) {
    throw Object.assign(new Error('Invalid commission rate scope'), { statusCode: 400 })
  }
  if (scopeType !== 'global' && !scopeId) {
    throw Object.assign(new Error('A scoped rate requires its product, category, or salesperson'), { statusCode: 400 })
  }
  if (!effectiveFrom || Number.isNaN(Date.parse(effectiveFrom))) {
    throw Object.assign(new Error('A valid rate effective date is required'), { statusCode: 400 })
  }
  if (effectiveTo && Date.parse(effectiveTo) < Date.parse(effectiveFrom)) {
    throw Object.assign(new Error('Rate end date must not be before its start date'), { statusCode: 400 })
  }
  const normalizedFrom = allowBackdate ? normalizeNairobiTimestamp(effectiveFrom) : requireProspectivePolicyTimestamp(normalizeNairobiTimestamp(effectiveFrom), 'Commission rate')
  const normalizedTo = effectiveTo
    ? normalizeNairobiTimestamp(effectiveTo, /^\d{4}-\d{2}-\d{2}$/.test(effectiveTo))
    : null
  if (normalizedTo && normalizedTo < normalizedFrom) {
    throw Object.assign(new Error('Rate end date must not be before its start date'), { statusCode: 400 })
  }
  if (!allowBackdate && normalizedTo && normalizedTo < normalizeNairobiTimestamp(new Date())) {
    throw Object.assign(new Error('Rate end date must be current or future'), { statusCode: 400 })
  }
  return transaction(async client => {
    if (replaceRateId) {
      const existing = await client.query(
        `SELECT id FROM commission_rates
         WHERE id = $1 AND programme_id = $2 AND scope_type = $3
           AND scope_id IS NOT DISTINCT FROM $4
         FOR UPDATE`,
        [replaceRateId, programmeId, scopeType, scopeId]
      )
      if (!existing.rows.length) {
        throw Object.assign(new Error('Rate to replace was not found for this scope'), { statusCode: 404 })
      }
    }
    const overlaps = await client.query(
      `SELECT id, effective_from >= $4::timestamp AS starts_at_or_after
       FROM commission_rates
       WHERE programme_id = $1 AND scope_type = $2 AND scope_id IS NOT DISTINCT FROM $3
         AND ($6::uuid IS NULL OR id <> $6::uuid)
         AND effective_from <= COALESCE($5::timestamp, 'infinity'::timestamp)
         AND (effective_to IS NULL OR effective_to >= $4::timestamp)
       FOR UPDATE`,
      [programmeId, scopeType, scopeId, normalizedFrom, normalizedTo, replaceRateId]
    )
    if (overlaps.rows.some((row: any) => row.starts_at_or_after)) {
      throw Object.assign(new Error('This rate overlaps an existing current or scheduled rate for the same scope'), { statusCode: 409 })
    }
    if (overlaps.rows.length > 0) {
      await client.query(
        `UPDATE commission_rates
         SET effective_to = $2::timestamp - INTERVAL '1 millisecond'
         WHERE id = ANY($1::uuid[])`,
        [overlaps.rows.map((row: any) => row.id), normalizedFrom]
      )
    }
    const result = replaceRateId
      ? await client.query(
        `UPDATE commission_rates
         SET rate_per_item = $2, effective_from = $3, effective_to = $4,
             scope_name = $5, created_by = $6
         WHERE id = $1
         RETURNING *`,
        [replaceRateId, ratePerItem, normalizedFrom, normalizedTo, scopeName, userId]
      )
      : await client.query(
        `INSERT INTO commission_rates (programme_id, rate_per_item, effective_from, effective_to, scope_type, scope_id, scope_name, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         RETURNING *`,
        [programmeId, ratePerItem, normalizedFrom, normalizedTo, scopeType, scopeId, scopeName, userId]
      )
    await logAudit({
      client,
      userId,
      action: 'commission_rate_set',
      entityType: 'commission_rate',
      entityId: result.rows[0].id,
      newValues: { programme_id: programmeId, rate_per_item: ratePerItem, scope_type: scopeType, scope_name: scopeName, effective_from: normalizedFrom, effective_to: normalizedTo }
    })
    return result.rows[0]
  })
}

export async function getEligibility(
  programmeId: string,
  scopeType: 'category' | 'product',
  scopeId: string,
  asOfDate?: string,
  executor?: DbExecutor
): Promise<CommissionEligibility | null> {
  const now = normalizeNairobiTimestamp(asOfDate || new Date().toISOString())
  const result = await executorOrDefault(executor).query(
    `SELECT id, programme_id, scope_type, scope_id, scope_name, is_eligible, effective_from, effective_to, created_by, created_at
     FROM commission_eligibility
     WHERE programme_id = $4
       AND scope_type = $1
       AND scope_id = $2
       AND effective_from <= $3::timestamp
       AND (effective_to IS NULL OR effective_to >= $3::timestamp)
     ORDER BY effective_from DESC, created_at DESC, id DESC
     LIMIT 1`,
    [scopeType, scopeId, now, programmeId]
  )
  return result.rows[0] || null
}

export async function programmeHasEligibilityRules(programmeId: string, asOfDate: string, executor?: DbExecutor): Promise<boolean> {
  const businessTimestamp = normalizeNairobiTimestamp(asOfDate)
  const result = await executorOrDefault(executor).query(
    `SELECT id FROM commission_eligibility
     WHERE programme_id = $2
       AND effective_from <= $1::timestamp
       AND (effective_to IS NULL OR effective_to >= $1::timestamp)
     LIMIT 1`,
    [businessTimestamp, programmeId]
  )
  return result.rows.length > 0
}

async function programmeNeedsCategorySnapshot(programmeId: string, asOfDate: string, executor?: DbExecutor): Promise<boolean> {
  const businessTimestamp = normalizeNairobiTimestamp(asOfDate)
  const result = await executorOrDefault(executor).query(
    `SELECT EXISTS (
       SELECT 1 FROM commission_rates
       WHERE programme_id = $1 AND scope_type = 'category'
         AND effective_from <= $2::timestamp
         AND (effective_to IS NULL OR effective_to >= $2::timestamp)
     ) OR EXISTS (
       SELECT 1 FROM commission_eligibility
       WHERE programme_id = $1 AND scope_type = 'category'
         AND effective_from <= $2::timestamp
         AND (effective_to IS NULL OR effective_to >= $2::timestamp)
     ) AS required`,
    [programmeId, businessTimestamp]
  )
  return result.rows[0]?.required === true
}

export async function setEligibility(
  programmeId: string,
  scopeType: string,
  scopeId: string,
  scopeName: string,
  isEligible: boolean,
  effectiveFrom: string,
  effectiveTo: string | null,
  userId: string | null,
  allowBackdate = false,
  replaceEligibilityId: string | null = null
): Promise<CommissionEligibility> {
  if (!['category', 'product'].includes(scopeType) || !scopeId || !String(scopeName || '').trim()) {
    throw Object.assign(new Error('A valid product or category is required'), { statusCode: 400 })
  }
  if (!effectiveFrom || Number.isNaN(Date.parse(effectiveFrom))) {
    throw Object.assign(new Error('A valid eligibility effective date is required'), { statusCode: 400 })
  }
  if (effectiveTo && Date.parse(effectiveTo) < Date.parse(effectiveFrom)) {
    throw Object.assign(new Error('Eligibility end date must not be before its start date'), { statusCode: 400 })
  }
  const normalizedFrom = allowBackdate ? normalizeNairobiTimestamp(effectiveFrom) : requireProspectivePolicyTimestamp(normalizeNairobiTimestamp(effectiveFrom), 'Eligibility rule')
  const normalizedTo = effectiveTo
    ? normalizeNairobiTimestamp(effectiveTo, /^\d{4}-\d{2}-\d{2}$/.test(effectiveTo))
    : null
  if (normalizedTo && normalizedTo < normalizedFrom) {
    throw Object.assign(new Error('Eligibility end date must not be before its start date'), { statusCode: 400 })
  }
  if (!allowBackdate && normalizedTo && normalizedTo < normalizeNairobiTimestamp(new Date())) {
    throw Object.assign(new Error('Eligibility end date must be current or future'), { statusCode: 400 })
  }
  return transaction(async client => {
    if (replaceEligibilityId) {
      const existing = await client.query(
        `SELECT id FROM commission_eligibility
         WHERE id = $1 AND programme_id = $2 AND scope_type = $3 AND scope_id = $4
         FOR UPDATE`,
        [replaceEligibilityId, programmeId, scopeType, scopeId]
      )
      if (!existing.rows.length) {
        throw Object.assign(new Error('Eligibility rule to replace was not found for this scope'), { statusCode: 404 })
      }
    }
    const overlaps = await client.query(
      `SELECT id, effective_from >= $4::timestamp AS starts_at_or_after
       FROM commission_eligibility
       WHERE programme_id = $1 AND scope_type = $2 AND scope_id = $3
         AND ($6::uuid IS NULL OR id <> $6::uuid)
         AND effective_from <= COALESCE($5::timestamp, 'infinity'::timestamp)
         AND (effective_to IS NULL OR effective_to >= $4::timestamp)
       FOR UPDATE`,
      [programmeId, scopeType, scopeId, normalizedFrom, normalizedTo, replaceEligibilityId]
    )
    if (overlaps.rows.some((row: any) => row.starts_at_or_after)) {
      throw Object.assign(new Error('This eligibility rule overlaps an existing current or scheduled rule for the same scope'), { statusCode: 409 })
    }
    if (overlaps.rows.length > 0) {
      await client.query(
        `UPDATE commission_eligibility
         SET effective_to = $2::timestamp - INTERVAL '1 millisecond'
         WHERE id = ANY($1::uuid[])`,
        [overlaps.rows.map((row: any) => row.id), normalizedFrom]
      )
    }
    const result = replaceEligibilityId
      ? await client.query(
        `UPDATE commission_eligibility
         SET scope_name = $2, is_eligible = $3, effective_from = $4,
             effective_to = $5, created_by = $6
         WHERE id = $1
         RETURNING *`,
        [replaceEligibilityId, scopeName, isEligible, normalizedFrom, normalizedTo, userId]
      )
      : await client.query(
        `INSERT INTO commission_eligibility (programme_id, scope_type, scope_id, scope_name, is_eligible, effective_from, effective_to, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         RETURNING *`,
        [programmeId, scopeType, scopeId, scopeName, isEligible, normalizedFrom, normalizedTo, userId]
      )
    await logAudit({
      client,
      userId,
      action: 'commission_eligibility_updated',
      entityType: 'commission_eligibility',
      entityId: result.rows[0].id,
      newValues: { programme_id: programmeId, scope_type: scopeType, scope_name: scopeName, is_eligible: isEligible, effective_from: normalizedFrom, effective_to: normalizedTo }
    })
    return result.rows[0]
  })
}

export async function evaluateOrderItem(
  orderId: string,
  orderItemId: string,
  orderStatus: string,
  deliveryType: string,
  courierPaymentType: string | null,
  paidAmount: number,
  totalAmount: number,
  productId: string,
  categoryId: string | null,
  quantity: number,
  salespersonId: string | null,
  qualificationDate: string,
  executor?: DbExecutor,
  ignoreExistingEarned = false
): Promise<{ eligible: boolean; reason?: string }> {
  const programme = await getProgrammeAsOf(qualificationDate, executor)
  if (!programme) {
    return { eligible: false, reason: 'No active commission programme' }
  }

  if (!salespersonId) {
    return { eligible: false, reason: 'No salesperson attribution' }
  }

  if (quantity <= 0) {
    return { eligible: false, reason: 'Zero or negative quantity' }
  }

  const eligibility = await getEligibility(programme.id, 'product', productId, qualificationDate, executor)
  if (!eligibility) {
    const hasRules = await programmeHasEligibilityRules(programme.id, qualificationDate, executor)
    if (hasRules) {
      const catEligibility = categoryId ? await getEligibility(programme.id, 'category', categoryId, qualificationDate, executor) : null
      if (!catEligibility || !catEligibility.is_eligible) {
        return { eligible: false, reason: 'Product or category not eligible' }
      }
    }
  } else if (!eligibility.is_eligible) {
    return { eligible: false, reason: 'Product explicitly ineligible' }
  }

  const rate = await getRateForItem(programme.id, productId, categoryId, salespersonId, qualificationDate, executor)
  if (rate <= 0) {
    return { eligible: false, reason: 'No applicable commission rate' }
  }

  if (deliveryType === 'courier' && courierPaymentType === 'cod') {
    if (orderStatus !== 'collected_paid') {
      return { eligible: false, reason: 'Speedaf COD order not yet fully remitted and completed' }
    }
  } else if (orderStatus !== 'delivered' && orderStatus !== 'collected_paid') {
    return { eligible: false, reason: 'Order not in a completed state' }
  }

  if (paidAmount < totalAmount) {
    return { eligible: false, reason: 'Order payment not fully settled' }
  }

  if (!ignoreExistingEarned) {
    const existingResult = await executorOrDefault(executor).query(
      `SELECT id FROM commission_transactions
       WHERE order_item_id = $1 AND transaction_type = 'earned' AND transaction_status <> 'reversed'`,
      [orderItemId]
    )
    if (existingResult.rows.length > 0) {
      return { eligible: false, reason: 'Commission already earned for this order item' }
    }
  }

  return { eligible: true }
}

export interface AuthoritativeCommissionEvaluation {
  eligible: boolean
  reason?: string
  alreadyEarned?: boolean
  orderId: string
  orderNumber?: string
  orderItemId: string
  productId?: string
  productName?: string
  categoryId?: string | null
  categorySnapshotVerified?: boolean
  categorySnapshotRequired?: boolean
  quantity?: number
  originalQuantity?: number
  returnedQuantity?: number
  salespersonId?: string
  salespersonName?: string
  saleDate?: string
  policyAt?: string
  qualificationAt?: string
  qualificationDate?: string
  qualificationSource?: string
  programmeId?: string
  rate?: number
  amount?: number
}

export async function evaluateOrderItemFromRecords(
  orderId: string,
  orderItemId: string,
  executor?: DbExecutor,
  options: { ignoreExistingEarned?: boolean } = {}
): Promise<AuthoritativeCommissionEvaluation> {
  const db = executorOrDefault(executor)
  const result = await db.query(
    `SELECT o.id AS order_id, o.order_number, o.status, o.delivery_type, o.courier_payment_type,
            o.payment_status, o.paid_amount, o.total_amount, o.sale_date, o.created_at, o.updated_at,
            o.created_by AS salesperson_id, u.full_name AS salesperson_name, u.role AS salesperson_role,
            u.commission_eligible AS user_commission_eligible,
            o.commission_salesperson_eligible,
            oi.id AS order_item_id, oi.product_id, oi.quantity, oi.returned_quantity, oi.fulfillment_status,
            oi.product_category_snapshot_verified, p.name AS product_name,
            COALESCE(oi.product_category_id, p.category_id) AS category_id,
            d.delivered_at AS delivery_delivered_at,
            cc.status AS cod_status, cc.cod_amount, cc.remitted_amount, cc.delivered_at AS cod_delivered_at,
            cc.remitted_at AS cod_remitted_at,
            (SELECT MIN(payment_at) FROM (
               SELECT op.created_at AS payment_at,
                      SUM(op.amount) OVER (ORDER BY op.created_at, op.id) AS cumulative_amount
               FROM order_payments op
               WHERE op.order_id = o.id
             ) payment_progress
             WHERE cumulative_amount >= o.total_amount) AS fully_paid_at,
            completion_event.completed_at,
            completion_event.completed_by,
            (SELECT COUNT(*)::int FROM order_refunds r
             WHERE r.order_id = o.id AND r.status IN ('pending','paid')) AS refund_count
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id AND oi.id = $2
     JOIN products p ON p.id = oi.product_id
     LEFT JOIN users u ON u.id = o.created_by
     LEFT JOIN deliveries d ON d.order_id = o.id
     LEFT JOIN cod_collections cc ON cc.order_id = o.id
     LEFT JOIN LATERAL (
       SELECT al.created_at AS completed_at, al.user_id AS completed_by
       FROM audit_logs al
       WHERE al.entity_type = 'order' AND al.entity_id = o.id
         AND al.action = 'order_status_changed'
         AND al.new_values->>'status' IN ('delivered','collected_paid')
       ORDER BY al.created_at DESC, al.id DESC
       LIMIT 1
     ) completion_event ON TRUE
     WHERE o.id = $1`,
    [orderId, orderItemId]
  )
  const row = result.rows[0]
  const base = { orderId, orderItemId }
  if (!row) return { ...base, eligible: false, reason: 'Order or order item does not exist' }
  const originalQuantity = toNumber(row.quantity)
  const returnedQuantity = Math.max(0, toNumber(row.returned_quantity))
  const commissionableQuantity = Math.max(0, originalQuantity - returnedQuantity)
  // Older rows were backfilled from the product's *current* category. That is
  // not evidence of the historic category, so automatic earning/reconciliation
  // must stop and request a reviewed adjustment instead of guessing.
  const categorySnapshotVerified = row.product_category_snapshot_verified === true
  const categoryId = categorySnapshotVerified ? row.category_id : null
  const saleDate = dateOnly(row.sale_date || row.created_at)
  const policyAt = `${saleDate} 00:00:00.000`
  const details = {
    ...base,
    orderNumber: row.order_number,
    productId: row.product_id,
    productName: row.product_name,
    categoryId,
    categorySnapshotVerified,
    quantity: commissionableQuantity,
    originalQuantity,
    returnedQuantity,
    salespersonId: row.salesperson_id,
    salespersonName: row.salesperson_name,
    saleDate,
    policyAt
  }

  if (!row.salesperson_id) {
    return { ...details, eligible: false, reason: 'Order has no salesperson attribution' }
  }
  if (['admin', 'owner'].includes(String(row.salesperson_role || '').toLowerCase()) || row.commission_salesperson_eligible !== true) {
    return { ...details, eligible: false, reason: 'Order creator is not eligible for sales commission' }
  }
  if (!await isCommissionModuleEnabled(db)) {
    return { ...details, eligible: false, reason: 'Commission module is disabled' }
  }
  if (commissionableQuantity <= 0) {
    return { ...details, eligible: false, reason: 'All quantities on this order item were returned' }
  }
  if (!['delivered', 'collected_paid'].includes(row.status)) {
    return { ...details, eligible: false, reason: `Order is ${row.status}; completion is required` }
  }
  if (Number(row.refund_count || 0) > 0) {
    const refundProgramme = await getProgrammeAsOf(policyAt, db)
    const categorySnapshotRequired = refundProgramme
      ? await programmeNeedsCategorySnapshot(refundProgramme.id, policyAt, db)
      : false
    return { ...details, categorySnapshotRequired, eligible: false, reason: 'Order has an active or paid refund' }
  }
  if (row.payment_status !== 'paid' || toNumber(row.paid_amount) < toNumber(row.total_amount)) {
    return { ...details, eligible: false, reason: 'Full payment has not been recorded' }
  }

  const isSpeedafCod = row.delivery_type === 'courier' && row.courier_payment_type === 'cod'
  if (isSpeedafCod) {
    if (!row.cod_delivered_at) {
      return { ...details, eligible: false, reason: 'Speedaf customer delivery has not been recorded' }
    }
    if (!['remitted', 'closed'].includes(row.cod_status) || !row.cod_remitted_at || toNumber(row.remitted_amount) < toNumber(row.cod_amount)) {
      return { ...details, eligible: false, reason: 'Speedaf remittance is not fully recorded and verified' }
    }
    if (row.status !== 'collected_paid') {
      return { ...details, eligible: false, reason: 'Speedaf order has not reached collected and paid' }
    }
  } else if (['rider', 'courier'].includes(row.delivery_type) && !row.delivery_delivered_at) {
    return { ...details, eligible: false, reason: 'Delivery completion has not been recorded' }
  }

  const qualification = latestTimestamp([
    { value: isSpeedafCod ? row.cod_remitted_at : null, source: 'speedaf_full_remittance' },
    { value: row.fully_paid_at, source: 'full_payment' },
    { value: row.completed_at, source: 'valid_order_completion' },
    { value: row.delivery_delivered_at || row.cod_delivered_at, source: 'delivery_confirmation' }
  ])
  if (!qualification) {
    return { ...details, eligible: false, reason: 'Required payment, completion, or delivery evidence is missing; review required' }
  }
  const qualificationDate = nairobiDate(qualification.timestamp)
  const programme = await getProgrammeAsOf(policyAt, db)
  if (!programme) {
    const state = await getProgrammeStateAsOf(policyAt, db)
    return {
      ...details,
      eligible: false,
      reason: state ? `Commission programme was ${state.status} on the sale date` : 'Commission programme was not configured on the sale date',
      qualificationAt: qualification.timestamp,
      qualificationDate,
      qualificationSource: qualification.source
    }
  }
  const categoryRequired = await programmeNeedsCategorySnapshot(programme.id, policyAt, db)
  if (!categorySnapshotVerified && categoryRequired) {
    return {
      ...details,
      eligible: false,
      reason: 'Historic product category snapshot is unavailable for a category-based commission rule; review is required.',
      qualificationAt: qualification.timestamp,
      qualificationDate,
      qualificationSource: qualification.source
    }
  }

  const ruleEvaluation = await evaluateOrderItem(
    orderId,
    orderItemId,
    row.status,
    row.delivery_type,
    row.courier_payment_type,
    toNumber(row.paid_amount),
    toNumber(row.total_amount),
    row.product_id,
    categoryId,
    commissionableQuantity,
    row.salesperson_id,
    policyAt,
    db,
    options.ignoreExistingEarned === true
  )
  const rate = await getRateForItem(programme.id, row.product_id, categoryId, row.salesperson_id, policyAt, db)
  const alreadyEarned = ruleEvaluation.reason === 'Commission already earned for this order item'
  return {
    ...details,
    eligible: ruleEvaluation.eligible,
    reason: ruleEvaluation.reason,
    alreadyEarned,
    qualificationAt: qualification.timestamp,
    qualificationDate,
    qualificationSource: qualification.source,
    programmeId: programme.id,
    rate,
    amount: commissionableQuantity * rate
  }
}

export async function evaluateAndEarnOrderItem(
  orderId: string,
  orderItemId: string,
  createdBy: string | null,
  executor?: DbExecutor,
  referenceType: string | null = null,
  referenceId: string | null = null
): Promise<{ evaluation: AuthoritativeCommissionEvaluation; earned: { transactionId: string; amount: number } | null }> {
  return withExecutorTransaction(executor, async client => {
    await client.query('SELECT id FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE', [orderItemId, orderId])
    const evaluation = await evaluateOrderItemFromRecords(orderId, orderItemId, client)
    if (!evaluation.eligible || !evaluation.productId || !evaluation.salespersonId || !evaluation.qualificationAt || !evaluation.policyAt) {
      return { evaluation, earned: null }
    }
    const earned = await earnCommission(
      orderId,
      orderItemId,
      evaluation.productId,
      evaluation.categoryId || null,
      evaluation.quantity || 0,
      evaluation.salespersonId,
      evaluation.qualificationAt,
      createdBy,
      client,
      referenceType,
      referenceId,
      evaluation.policyAt
    )
    return { evaluation, earned }
  })
}

export async function earnCommission(
  orderId: string,
  orderItemId: string,
  productId: string,
  categoryId: string | null,
  quantity: number,
  salespersonId: string,
  qualificationDate: string,
  createdBy: string | null,
  executor?: DbExecutor,
  referenceType: string | null = null,
  referenceId: string | null = null,
  policyDate: string = qualificationDate
): Promise<{ transactionId: string; amount: number } | null> {
  const programme = await getProgrammeAsOf(policyDate, executor)
  if (!programme) return null

  const rate = await getRateForItem(programme.id, productId, categoryId, salespersonId, policyDate, executor)
  if (rate <= 0) return null

  const qualificationTimestamp = new Date(qualificationDate).toISOString()
  const qualificationBusinessDate = nairobiDate(qualificationTimestamp)
  const qualificationBusinessTimestamp = normalizeNairobiTimestamp(qualificationTimestamp)
  const qualificationMonth = commissionPeriodForTimestamp(qualificationTimestamp)
  const sourcePeriod = commissionPeriodForTimestamp(policyDate)

  return withExecutorTransaction(executor, async (client) => {
    // A sale belongs to its source month while that month remains open. This
    // lets an August order completed during the September month-end review be
    // included in August. Once August is closed, the same late qualification
    // is routed to the current open period without rewriting closed history.
    await lockCommissionPeriod(client, sourcePeriod)
    const sourceClosure = await client.query(
      `SELECT id FROM commission_period_closures
       WHERE period_start = $1::date AND status = 'closed'`,
      [sourcePeriod]
    )
    let monthDate = sourceClosure.rows.length > 0 ? qualificationMonth : sourcePeriod
    if (monthDate !== sourcePeriod) await lockCommissionPeriod(client, monthDate)
    let targetClosure = await client.query(
      `SELECT id FROM commission_period_closures
       WHERE period_start = $1::date AND status = 'closed'`,
      [monthDate]
    )
    if (targetClosure.rows.length > 0) {
      monthDate = commissionPeriodForTimestamp(new Date())
      if (monthDate !== sourcePeriod && monthDate !== qualificationMonth) await lockCommissionPeriod(client, monthDate)
      targetClosure = await client.query(
        `SELECT id FROM commission_period_closures
         WHERE period_start = $1::date AND status = 'closed'`,
        [monthDate]
      )
    }
    if (targetClosure.rows.length > 0) {
      throw Object.assign(
        new Error('No open commission period is available for this earning'),
        { statusCode: 409 }
      )
    }
    const existingResult = await client.query(
      `SELECT id FROM commission_transactions
       WHERE order_item_id = $1 AND transaction_type = 'earned' AND transaction_status <> 'reversed'
       FOR UPDATE`,
      [orderItemId]
    )
    if (existingResult.rows.length > 0) {
      return null
    }

    const amount = quantity * rate

    const result = await client.query(
      `INSERT INTO commission_transactions
       (programme_id, salesperson_id, order_id, order_item_id, product_id, category_id, eligible_quantity, rate_per_item, amount, transaction_type, transaction_status, policy_date, qualification_date, qualified_at, commission_month, source_period, reason, reference_type, reference_id, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'earned', 'pending', $10::date, $11::date, $12::timestamp, $13::date, $14::date, $15, $16, $17, $18, NOW())
       RETURNING id, amount`,
      [programme.id, salespersonId, orderId, orderItemId, productId, categoryId, quantity, rate, amount, dateOnly(policyDate), qualificationBusinessDate, qualificationBusinessTimestamp, monthDate, sourcePeriod,
       monthDate !== sourcePeriod ? `Late qualification from closed commission period ${sourcePeriod}` : null,
       referenceType, referenceId, createdBy]
    )

    await logAudit({
      client,
      userId: createdBy,
      action: 'commission_earned',
      entityType: 'commission_transaction',
      entityId: result.rows[0].id,
      newValues: { order_id: orderId, order_item_id: orderItemId, salesperson_id: salespersonId, policy_date: dateOnly(policyDate), qualification_date: qualificationBusinessDate, commission_month: monthDate, source_period: sourcePeriod, quantity, rate_per_item: rate, amount }
    })

    return { transactionId: result.rows[0].id, amount }
  })
}

export async function reverseCommission(
  originalTransactionId: string,
  orderId: string,
  orderItemId: string,
  quantity: number,
  reason: string,
  createdBy: string | null,
  executor?: DbExecutor,
  referenceType: string | null = null,
  referenceId: string | null = null
): Promise<{ transactionId: string; amount: number } | null> {
  return withExecutorTransaction(executor, async (client) => {
    const originalResult = await client.query(
      `SELECT id, programme_id, salesperson_id, product_id, category_id, rate_per_item, amount,
              eligible_quantity, commission_month, source_period, transaction_status
       FROM commission_transactions
       WHERE id = $1 AND transaction_type = 'earned'
       FOR UPDATE`,
      [originalTransactionId]
    )
    const original = originalResult.rows[0]
    if (!original) return null

    const priorResult = await client.query(
      `SELECT COALESCE(SUM(eligible_quantity), 0)::int AS reversed_quantity
       FROM commission_transactions
       WHERE original_transaction_id = $1 AND transaction_type = 'reversal'`,
      [originalTransactionId]
    )
    const alreadyReversed = Number(priorResult.rows[0]?.reversed_quantity || 0)
    const remainingQuantity = Math.max(0, Number(original.eligible_quantity) - alreadyReversed)
    const requestedQuantity = Number(quantity)
    if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0) return null
    const reversalQuantity = Math.min(requestedQuantity, remainingQuantity)
    const rate = toNumber(original.rate_per_item)
    const reversalAmount = reversalQuantity * rate

    if (reversalAmount <= 0) return null

    const now = new Date().toISOString()
    const currentDate = nairobiDate(now)
    const currentTimestamp = normalizeNairobiTimestamp(now)
    const currentMonth = currentDate.slice(0, 7) + '-01'
    const sourcePeriod = dateOnly(original.commission_month)
    await lockCommissionPeriod(client, sourcePeriod)
    const sourceClosure = await client.query(
      `SELECT id FROM commission_period_closures WHERE period_start=$1::date AND status='closed'`,
      [sourcePeriod]
    )
    const targetMonth = sourceClosure.rows.length > 0 ? currentMonth : sourcePeriod
    if (targetMonth !== sourcePeriod) await lockCommissionPeriod(client, targetMonth)
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [original.salesperson_id, targetMonth]
    )
    // A reversal must immediately reduce a previously approved/payable amount.
    // For a not-yet-approved earning it remains pending for normal review.
    const reversalStatus = ['approved', 'paid'].includes(original.transaction_status) ? 'approved' : 'pending'

    const result = await client.query(
      `INSERT INTO commission_transactions
       (programme_id, salesperson_id, order_id, order_item_id, product_id, category_id, eligible_quantity, rate_per_item, amount, transaction_type, transaction_status, qualification_date, qualified_at, commission_month, source_period, original_transaction_id, reference_type, reference_id, reason, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'reversal', $10, $11::date, $12::timestamp, $13::date, $14::date, $15, $16, $17, $18, $19, NOW())
       RETURNING id, amount`,
      [original.programme_id, original.salesperson_id, orderId, orderItemId, original.product_id, original.category_id, reversalQuantity, rate, reversalAmount, reversalStatus, currentDate, currentTimestamp, targetMonth, original.source_period || sourcePeriod, originalTransactionId, referenceType, referenceId,
       targetMonth !== sourcePeriod ? `[Correction for closed commission period ${sourcePeriod}] ${reason}` : reason,
       createdBy]
    )

    if (alreadyReversed + reversalQuantity >= Number(original.eligible_quantity)) {
      await client.query(
        `UPDATE commission_transactions
         SET transaction_status = 'reversed'
         WHERE id = $1
           AND NOT EXISTS (
             SELECT 1 FROM commission_period_closures
             WHERE period_start = $2::date AND status = 'closed'
           )`,
        [originalTransactionId, original.commission_month]
      )
    }

    await logAudit({
      client,
      userId: createdBy,
      action: 'commission_reversed',
      entityType: 'commission_transaction',
      entityId: result.rows[0].id,
      newValues: { original_transaction_id: originalTransactionId, order_id: orderId, order_item_id: orderItemId, reversal_quantity: reversalQuantity, amount: reversalAmount, reason, reference_type: referenceType, reference_id: referenceId }
    })

    return { transactionId: result.rows[0].id, amount: reversalAmount }
  })
}

export async function getSalespersonCommissionSummary(
  salespersonId: string,
  dateFrom: string,
  dateTo: string
) {
  const activityDate = (alias: string) => `(CASE
    WHEN ${alias}.transaction_type='earned'
      AND date_trunc('month', ${alias}.policy_date)::date=${alias}.commission_month THEN ${alias}.policy_date
    WHEN ${alias}.source_period IS NOT NULL AND ${alias}.commission_month=${alias}.source_period THEN ${alias}.commission_month
    ELSE ${alias}.qualification_date END)`
  const result = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN transaction_type = 'earned' THEN amount ELSE 0 END), 0) AS gross_earned,
       COALESCE(SUM(CASE WHEN transaction_type = 'reversal' THEN amount ELSE 0 END), 0) AS reversals,
       COALESCE(SUM(CASE WHEN transaction_type = 'manual_add' THEN amount ELSE 0 END), 0) AS manual_additions,
       COALESCE(SUM(CASE WHEN transaction_type = 'manual_deduct' THEN amount ELSE 0 END), 0) AS manual_deductions,
       COALESCE(SUM(CASE WHEN transaction_type = 'carry_forward' AND carry_forward_direction = 'credit' THEN amount ELSE 0 END), 0) AS carry_forward_credits,
       COALESCE(SUM(CASE WHEN transaction_type = 'carry_forward' AND carry_forward_direction = 'deduction' THEN amount ELSE 0 END), 0) AS carry_forward_deductions,
       COALESCE((SELECT SUM(cp.paid_amount)
                 FROM commission_payments cp
                 LEFT JOIN commission_transactions paid_ct ON paid_ct.id=cp.commission_transaction_id
                 WHERE cp.salesperson_id=$1 AND cp.status <> 'voided'
                   AND ((cp.commission_transaction_id IS NOT NULL
                         AND ${activityDate('paid_ct')} >= $2::date AND ${activityDate('paid_ct')} <= $3::date)
                     OR (cp.commission_transaction_id IS NULL
                         AND cp.period_start >= $2::date AND cp.period_start <= $3::date))), 0) AS payments,
       COALESCE((SELECT SUM(cp.paid_amount) FROM commission_payments cp
                 WHERE cp.salesperson_id = $1 AND cp.status <> 'voided'
                   AND cp.paid_at::date >= $2::date AND cp.paid_at::date <= $3::date), 0) AS settled_in_period,
       COALESCE(SUM(CASE
         WHEN transaction_status IN ('approved','paid','reversed') AND transaction_type IN ('earned','manual_add') THEN amount
         WHEN transaction_status IN ('approved','paid','reversed') AND transaction_type = 'carry_forward' AND carry_forward_direction = 'credit' THEN amount
         ELSE 0 END), 0) AS approved_credits,
       COALESCE(SUM(CASE
         WHEN transaction_type = 'reversal' THEN amount
         WHEN transaction_status IN ('approved','paid') AND transaction_type = 'manual_deduct' THEN amount
         WHEN transaction_status IN ('approved','paid') AND transaction_type = 'carry_forward' AND carry_forward_direction = 'deduction' THEN amount
         ELSE 0 END), 0) AS approved_deductions,
       COUNT(CASE WHEN transaction_type = 'earned' THEN 1 END) AS earned_count,
       COUNT(CASE WHEN transaction_type = 'reversal' THEN 1 END) AS reversal_count
     FROM commission_transactions
     WHERE salesperson_id = $1
       AND ${activityDate('commission_transactions')} >= $2::date
       AND ${activityDate('commission_transactions')} <= $3::date`,
    [salespersonId, dateFrom, dateTo]
  )
  const row = result.rows[0]
  const grossEarned = toNumber(row.gross_earned)
  const reversals = toNumber(row.reversals)
  const manualAdditions = toNumber(row.manual_additions)
  const manualDeductions = toNumber(row.manual_deductions)
  const carryForwardCredits = toNumber(row.carry_forward_credits)
  const carryForwardDeductions = toNumber(row.carry_forward_deductions)
  const payments = toNumber(row.payments)
  const netCommission = grossEarned - reversals + manualAdditions - manualDeductions + carryForwardCredits - carryForwardDeductions
  const outstandingAmount = netCommission - payments
  const approvedBalance = toNumber(row.approved_credits) - toNumber(row.approved_deductions) - payments
  const approvedPayable = Math.max(0, approvedBalance)
  return {
    grossEarned,
    reversals,
    manualAdditions,
    manualDeductions,
    carryForwardCredits,
    carryForwardDeductions,
    netCommission,
    paidAmount: payments,
    settledInPeriod: toNumber(row.settled_in_period),
    outstandingAmount,
    payableAmount: approvedPayable,
    approvedPayable,
    pendingAmount: outstandingAmount - approvedBalance,
    recoveryDue: Math.max(0, -approvedBalance),
    approvedAmount: approvedPayable,
    earnedCount: Number(row.earned_count || 0),
    reversalCount: Number(row.reversal_count || 0)
  }
}

export async function getSalespersonDailyCommission(
  salespersonId: string,
  dateFrom: string,
  dateTo: string
) {
  const result = await query(
    `SELECT
       qualification_date,
       COALESCE(SUM(CASE WHEN transaction_type = 'earned' THEN eligible_quantity ELSE 0 END), 0) AS eligible_items,
       COALESCE(SUM(CASE WHEN transaction_type = 'earned' THEN amount ELSE 0 END), 0) AS gross_commission,
       COALESCE(SUM(CASE WHEN transaction_type = 'reversal' THEN amount ELSE 0 END), 0) AS reversals,
       COALESCE(SUM(CASE WHEN transaction_type = 'manual_add' THEN amount ELSE 0 END), 0) AS manual_additions,
       COALESCE(SUM(CASE WHEN transaction_type = 'manual_deduct' THEN amount ELSE 0 END), 0) AS manual_deductions,
       COALESCE(SUM(CASE WHEN transaction_type = 'carry_forward' AND carry_forward_direction = 'credit' THEN amount ELSE 0 END), 0) AS carry_forward_credits,
       COALESCE(SUM(CASE WHEN transaction_type = 'carry_forward' AND carry_forward_direction = 'deduction' THEN amount ELSE 0 END), 0) AS carry_forward_deductions,
       COALESCE(SUM(CASE
         WHEN transaction_type IN ('earned','manual_add') THEN amount
         WHEN transaction_type IN ('reversal','manual_deduct') THEN -amount
         WHEN transaction_type = 'carry_forward' AND carry_forward_direction = 'credit' THEN amount
         WHEN transaction_type = 'carry_forward' AND carry_forward_direction = 'deduction' THEN -amount
         ELSE 0 END), 0) AS net_commission
     FROM commission_transactions
     WHERE salesperson_id = $1
       AND qualification_date >= $2
       AND qualification_date <= $3
     GROUP BY qualification_date
     ORDER BY qualification_date DESC`,
    [salespersonId, dateFrom, dateTo]
  )
  return result.rows.map(row => ({
    date: row.qualification_date,
    eligibleItems: Number(row.eligible_items || 0),
    grossCommission: toNumber(row.gross_commission),
    reversals: toNumber(row.reversals),
    manualAdditions: toNumber(row.manual_additions),
    manualDeductions: toNumber(row.manual_deductions),
    carryForwardCredits: toNumber(row.carry_forward_credits),
    carryForwardDeductions: toNumber(row.carry_forward_deductions),
    netCommission: toNumber(row.net_commission)
  }))
}

export async function getSalespersonCommissionTransactions(
  salespersonId: string,
  page: number,
  pageSize: number
) {
  const offset = (page - 1) * pageSize
  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM commission_transactions ct
     WHERE ct.salesperson_id = $1`,
    [salespersonId]
  )
  const result = await query(
    `SELECT ct.id, ct.order_id, COALESCE(o.order_number, 'Manual adjustment') AS order_number,
            ct.product_id, COALESCE(p.name, 'Commission adjustment') AS product_name, ct.eligible_quantity,
            ct.rate_per_item, ct.amount, ct.transaction_type, ct.carry_forward_direction, ct.transaction_status, ct.qualification_date,
            ct.qualified_at, ct.commission_month, ct.reason, u.full_name AS approved_by_name, ct.approved_at, ct.created_at,
             COALESCE((SELECT SUM(cp.paid_amount) FROM commission_payments cp WHERE cp.commission_transaction_id = ct.id AND cp.status <> 'voided'), 0) AS paid_amount,
             (SELECT MAX(cp.paid_at) FROM commission_payments cp WHERE cp.commission_transaction_id = ct.id AND cp.status <> 'voided') AS last_paid_at,
            (SELECT string_agg(
              CONCAT(COALESCE(cp.payment_method::text, 'payment'), ': ', COALESCE(NULLIF(cp.reference, ''), 'no reference'), ' — ', cp.paid_amount),
              '; ' ORDER BY cp.paid_at DESC, cp.created_at DESC
             ) FROM commission_payments cp WHERE cp.commission_transaction_id = ct.id AND cp.status <> 'voided') AS payment_references,
            COALESCE((SELECT SUM(reversal.amount) FROM commission_transactions reversal
                      WHERE reversal.original_transaction_id = ct.id AND reversal.transaction_type = 'reversal'), 0) AS reversed_amount
     FROM commission_transactions ct
     LEFT JOIN orders o ON o.id = ct.order_id
     LEFT JOIN products p ON p.id = ct.product_id
     LEFT JOIN users u ON u.id = ct.approved_by
     WHERE ct.salesperson_id = $1
     ORDER BY ct.created_at DESC
     LIMIT $2 OFFSET $3`,
    [salespersonId, pageSize, offset]
  )
  return {
    data: result.rows,
    pagination: {
      page,
      pageSize,
      total: countResult.rows[0]?.total || 0,
      totalPages: Math.ceil((countResult.rows[0]?.total || 0) / pageSize)
    }
  }
}

export async function getPotentialCommission(salespersonId: string) {
  if (!await isCommissionModuleEnabled()) return []
  const salesperson = await query(
    'SELECT role, commission_eligible FROM users WHERE id = $1',
    [salespersonId]
  )
  if (!salesperson.rows[0]?.commission_eligible || ['admin', 'owner'].includes(String(salesperson.rows[0]?.role || '').toLowerCase())) {
    return []
  }
  const result = await query(
    `SELECT o.id AS order_id, o.order_number, oi.id AS order_item_id, oi.product_id,
            COALESCE(oi.product_category_id, p.category_id) AS category_id,
            p.name AS product_name, oi.quantity, o.status AS order_status, o.delivery_type,
            o.courier_payment_type, o.payment_status, o.sale_date,
            oi.product_category_snapshot_verified, c.name AS category_name, cc.status AS cod_status
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     JOIN products p ON p.id = oi.product_id
     LEFT JOIN categories c ON c.id = COALESCE(oi.product_category_id, p.category_id)
     LEFT JOIN cod_collections cc ON cc.order_id = o.id
     WHERE o.created_by = $1
       AND o.commission_salesperson_eligible = TRUE
       AND o.status NOT IN ('cancelled', 'returned')
       AND NOT EXISTS (
         SELECT 1 FROM commission_transactions ct
         WHERE ct.order_item_id = oi.id AND ct.transaction_type = 'earned' AND ct.transaction_status <> 'reversed'
       )
     ORDER BY o.created_at DESC
     LIMIT 100`,
    [salespersonId]
  )
  const potential = []
  for (const row of result.rows) {
    const policyAt = `${dateOnly(row.sale_date)} 00:00:00.000`
    const programme = await getProgrammeAsOf(policyAt)
    if (!programme) continue
    const categoryId = row.product_category_snapshot_verified === true ? row.category_id : null
    if (!row.product_category_snapshot_verified && await programmeNeedsCategorySnapshot(programme.id, policyAt)) continue
    const productRule = await getEligibility(programme.id, 'product', row.product_id, policyAt)
    const categoryRule = categoryId ? await getEligibility(programme.id, 'category', categoryId, policyAt) : null
    const hasRules = await programmeHasEligibilityRules(programme.id, policyAt)
    const configuredEligible = productRule ? productRule.is_eligible : (!hasRules || Boolean(categoryRule?.is_eligible))
    const rate = await getRateForItem(programme.id, row.product_id, categoryId, salespersonId, policyAt)
    if (!configuredEligible || rate <= 0) continue
    const evaluation = await evaluateOrderItemFromRecords(row.order_id, row.order_item_id)
    if (evaluation.alreadyEarned) continue
    potential.push({
      orderId: row.order_id,
      orderNumber: row.order_number,
      orderItemId: row.order_item_id,
      productName: row.product_name,
      quantity: toNumber(row.quantity),
      estimatedCommission: toNumber(row.quantity) * rate,
      rate,
      orderStatus: row.order_status,
      paymentStatus: row.payment_status,
      deliveryType: row.delivery_type,
      courierPaymentType: row.courier_payment_type,
      codStatus: row.cod_status,
      categoryName: row.category_name,
      reason: evaluation.reason || 'Waiting for final commission processing'
    })
  }
  return potential
}

interface SalespersonMonthlyCommissionHistoryOptions {
  limit?: number
  includeEmptyMonths?: boolean
  monthFrom?: string
  monthTo?: string
}

export async function getSalespersonMonthlyCommissionHistory(
  salespersonId: string,
  options: SalespersonMonthlyCommissionHistoryOptions = {}
) {
  const safeLimit = Math.min(60, Math.max(1, Math.floor(options.limit || 24)))
  const monthFrom = options.monthFrom ? `${options.monthFrom.slice(0, 7)}-01` : null
  const monthTo = options.monthTo ? `${options.monthTo.slice(0, 7)}-01` : null
  const targetMonths: string[] = []

  if (options.includeEmptyMonths) {
    const endMonth = monthTo || `${nairobiDate(new Date()).slice(0, 7)}-01`
    const [endYear, endMonthNumber] = endMonth.slice(0, 7).split('-').map(Number)
    const startMonth = monthFrom || new Date(Date.UTC(endYear, endMonthNumber - safeLimit, 1)).toISOString().slice(0, 10)
    const [startYear, startMonthNumber] = startMonth.slice(0, 7).split('-').map(Number)
    const monthCount = Math.min(60, Math.max(0, (endYear - startYear) * 12 + endMonthNumber - startMonthNumber + 1))
    for (let offset = 0; offset < monthCount; offset += 1) {
      targetMonths.push(new Date(Date.UTC(endYear, endMonthNumber - 1 - offset, 1)).toISOString().slice(0, 10))
    }
  }

  const parameters: any[] = [salespersonId]
  let rangeCondition = ''
  if (targetMonths.length > 0) {
    parameters.push(targetMonths[targetMonths.length - 1], targetMonths[0])
    rangeCondition = `AND ct.commission_month BETWEEN $2::date AND $3::date`
  }
  parameters.push(safeLimit)
  const limitParameter = `$${parameters.length}`
  const result = await query(
    `SELECT ct.commission_month,
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'earned' THEN ct.eligible_quantity ELSE 0 END), 0) AS eligible_quantity,
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'earned' THEN ct.amount ELSE 0 END), 0) AS gross_earned,
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'reversal' THEN ct.amount ELSE 0 END), 0) AS reversals,
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'manual_add' THEN ct.amount ELSE 0 END), 0) AS manual_additions,
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'manual_deduct' THEN ct.amount ELSE 0 END), 0) AS manual_deductions,
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'carry_forward' AND ct.carry_forward_direction = 'credit' THEN ct.amount ELSE 0 END), 0) AS carry_forward_credits,
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'carry_forward' AND ct.carry_forward_direction = 'deduction' THEN ct.amount ELSE 0 END), 0) AS carry_forward_deductions,
       COALESCE(SUM(CASE
         WHEN ct.transaction_status IN ('approved','paid','reversed') AND ct.transaction_type IN ('earned','manual_add') THEN ct.amount
         WHEN ct.transaction_status IN ('approved','paid','reversed') AND ct.transaction_type = 'carry_forward' AND ct.carry_forward_direction = 'credit' THEN ct.amount
         ELSE 0 END), 0) AS approved_credits,
       COALESCE(SUM(CASE
         WHEN ct.transaction_type = 'reversal' THEN ct.amount
         WHEN ct.transaction_status IN ('approved','paid') AND ct.transaction_type = 'manual_deduct' THEN ct.amount
         WHEN ct.transaction_status IN ('approved','paid') AND ct.transaction_type = 'carry_forward' AND ct.carry_forward_direction = 'deduction' THEN ct.amount
         ELSE 0 END), 0) AS approved_deductions,
       COALESCE((SELECT SUM(cp.paid_amount) FROM commission_payments cp
                 WHERE cp.salesperson_id = $1 AND cp.status <> 'voided'
                   AND date_trunc('month', cp.period_start)::date = date_trunc('month', ct.commission_month)::date), 0) AS paid_amount,
       (SELECT MAX(cp.paid_at) FROM commission_payments cp
         WHERE cp.salesperson_id = $1 AND cp.status <> 'voided'
          AND date_trunc('month', cp.period_start)::date = date_trunc('month', ct.commission_month)::date) AS last_paid_at,
       (SELECT status FROM commission_period_closures closure
         WHERE closure.period_start = ct.commission_month LIMIT 1) AS period_status,
       (SELECT balance.closing_balance
          FROM commission_period_closures closure
          JOIN commission_period_closure_balances balance ON balance.closure_id = closure.id
         WHERE closure.period_start = ct.commission_month AND balance.salesperson_id = $1
         LIMIT 1) AS closure_balance,
       (SELECT balance.approved_credits
          FROM commission_period_closures closure
          JOIN commission_period_closure_balances balance ON balance.closure_id = closure.id
         WHERE closure.period_start = ct.commission_month AND balance.salesperson_id = $1
         LIMIT 1) AS closure_approved_credits,
       (SELECT balance.approved_deductions
          FROM commission_period_closures closure
          JOIN commission_period_closure_balances balance ON balance.closure_id = closure.id
         WHERE closure.period_start = ct.commission_month AND balance.salesperson_id = $1
         LIMIT 1) AS closure_approved_deductions
     FROM commission_transactions ct
     WHERE ct.salesperson_id = $1
       ${rangeCondition}
     GROUP BY ct.commission_month
     ORDER BY ct.commission_month DESC
     LIMIT ${limitParameter}`,
    parameters
  )

  const summarize = (row: any) => {
    const gross = toNumber(row.gross_earned)
    const reversals = toNumber(row.reversals)
    const additions = toNumber(row.manual_additions)
    const deductions = toNumber(row.manual_deductions)
    const carryForwardCredits = toNumber(row.carry_forward_credits)
    const carryForwardDeductions = toNumber(row.carry_forward_deductions)
    const net = gross - reversals + additions - deductions + carryForwardCredits - carryForwardDeductions
    const paid = toNumber(row.paid_amount)
    const outstanding = net - paid
    const approvedTotal = toNumber(row.approved_credits) - toNumber(row.approved_deductions)
    const approvedBalance = approvedTotal - paid
    const pendingAmount = outstanding - approvedBalance
    const periodStatus = row.period_status || 'open'
    const closureBalance = row.closure_balance == null ? null : toNumber(row.closure_balance)
    const closureApprovedTotal = row.closure_approved_credits == null
      ? null
      : toNumber(row.closure_approved_credits) - toNumber(row.closure_approved_deductions)
    const netEarned = periodStatus === 'closed' && closureApprovedTotal != null
      ? closureApprovedTotal
      : gross - reversals + additions - deductions
    const recoveryDue = Math.max(0, periodStatus === 'closed' && closureBalance != null ? -closureBalance : -approvedBalance)
    let status = 'in_progress'
    if (periodStatus === 'closed') status = recoveryDue > 0 ? 'closed_with_recovery' : 'paid_and_closed'
    else if (pendingAmount > 0) status = 'awaiting_approval'
    else if (approvedBalance > 0) status = 'ready_for_payment'
    else if (recoveryDue > 0) status = 'recovery_due'
    else if (paid > 0 && outstanding <= 0) status = 'paid'
    else if (net === 0) status = 'no_commission'
    return {
      month: row.commission_month,
      eligibleQuantity: Number(row.eligible_quantity || 0),
      grossEarned: gross,
      reversals,
      manualAdditions: additions,
      manualDeductions: deductions,
      carryForwardCredits,
      carryForwardDeductions,
      netEarned,
      netCommission: net,
      approvedAmount: Math.max(0, closureApprovedTotal ?? approvedTotal),
      approvedPayable: Math.max(0, approvedBalance),
      paidAmount: paid,
      outstandingAmount: outstanding,
      payableAmount: Math.max(0, approvedBalance),
      pendingAmount,
      recoveryDue,
      paymentStatus: approvedBalance <= 0 ? (paid > 0 ? 'paid_or_offset' : 'offset') : paid <= 0 ? 'unpaid' : 'partial',
      lastPaidAt: row.last_paid_at,
      periodStatus,
      status
    }
  }

  const summaries = new Map(result.rows.map(row => {
    const summary = summarize(row)
    return [String(summary.month).slice(0, 10), summary]
  }))
  if (targetMonths.length === 0) return [...summaries.values()]

  const closureResult = await query(
    `SELECT closure.period_start, closure.status, balance.closing_balance,
            balance.approved_credits, balance.approved_deductions
       FROM commission_period_closures closure
       LEFT JOIN commission_period_closure_balances balance
         ON balance.closure_id = closure.id AND balance.salesperson_id = $2
      WHERE closure.period_start = ANY($1::date[])`,
    [targetMonths, salespersonId]
  )
  const closureDetails = new Map(closureResult.rows.map(row => [String(row.period_start).slice(0, 10), row]))
  return targetMonths.map(month => summaries.get(month) || summarize({
    commission_month: month,
    period_status: closureDetails.get(month)?.status || 'open',
    closure_balance: closureDetails.get(month)?.closing_balance ?? null,
    closure_approved_credits: closureDetails.get(month)?.approved_credits ?? null,
    closure_approved_deductions: closureDetails.get(month)?.approved_deductions ?? null
  }))
}

export async function getManagementCommissionTransactions(
  dateFrom: string,
  dateTo: string,
  page: number,
  pageSize: number,
  status?: string,
  salespersonId?: string,
  commissionMonth?: string
) {
  const activityDate = (alias: string) => `(CASE
    WHEN ${alias}.transaction_type='earned'
      AND date_trunc('month', ${alias}.policy_date)::date=${alias}.commission_month THEN ${alias}.policy_date
    WHEN ${alias}.source_period IS NOT NULL AND ${alias}.commission_month=${alias}.source_period THEN ${alias}.commission_month
    ELSE ${alias}.qualification_date END)`
  const conditions = commissionMonth
    ? ['ct.commission_month = $1::date']
    : [`${activityDate('ct')} >= $1::date`, `${activityDate('ct')} <= $2::date`]
  const params: any[] = commissionMonth ? [commissionMonth] : [dateFrom, dateTo]
  if (status) {
    params.push(status)
    conditions.push(`ct.transaction_status = $${params.length}`)
  }
  if (salespersonId) {
    params.push(salespersonId)
    conditions.push(`ct.salesperson_id = $${params.length}`)
  }
  const where = conditions.join(' AND ')
  const count = await query(`SELECT COUNT(*)::int AS total FROM commission_transactions ct WHERE ${where}`, params)
  const bulkSelectionResult = await query(
    `WITH candidates AS (
       SELECT ct.id, ct.salesperson_id, ct.commission_month, ct.amount,
              ct.transaction_status, ct.transaction_type, ct.carry_forward_direction,
              ct.qualified_at, ct.created_at,
              COALESCE((SELECT SUM(cp.paid_amount) FROM commission_payments cp
                        WHERE cp.commission_transaction_id=ct.id AND cp.status <> 'voided'), 0) AS paid_amount,
              COALESCE((SELECT SUM(reversal.amount) FROM commission_transactions reversal
                        WHERE reversal.original_transaction_id=ct.id AND reversal.transaction_type='reversal'), 0) AS reversed_amount
       FROM commission_transactions ct
       WHERE ${where}
     ), candidate_groups AS (
       SELECT salesperson_id, commission_month,
              SUM(GREATEST(amount-paid_amount-reversed_amount, 0)) AS selected_balance
       FROM candidates
       WHERE transaction_status IN ('approved','paid')
         AND (transaction_type IN ('earned','manual_add')
           OR (transaction_type='carry_forward' AND carry_forward_direction='credit'))
         AND amount-paid_amount-reversed_amount > 0.004
       GROUP BY salesperson_id, commission_month
     ), period_ledger AS (
       SELECT ct.salesperson_id, ct.commission_month,
              COALESCE(SUM(CASE
                WHEN ct.transaction_type IN ('earned','manual_add') AND ct.transaction_status IN ('approved','paid','reversed') THEN ct.amount
                WHEN ct.transaction_type='carry_forward' AND ct.carry_forward_direction='credit' AND ct.transaction_status IN ('approved','paid','reversed') THEN ct.amount
                ELSE 0 END),0) AS credits,
              COALESCE(SUM(CASE
                WHEN ct.transaction_type='reversal' THEN ct.amount
                WHEN ct.transaction_type='manual_deduct' AND ct.transaction_status IN ('approved','paid') THEN ct.amount
                WHEN ct.transaction_type='carry_forward' AND ct.carry_forward_direction='deduction' AND ct.transaction_status IN ('approved','paid') THEN ct.amount
                ELSE 0 END),0) AS deductions
       FROM commission_transactions ct
       JOIN candidate_groups selected
         ON selected.salesperson_id=ct.salesperson_id AND selected.commission_month=ct.commission_month
       GROUP BY ct.salesperson_id, ct.commission_month
     ), period_payments AS (
       SELECT selected.salesperson_id, selected.commission_month,
              COALESCE(SUM(cp.paid_amount) FILTER (WHERE
                date_trunc('month', cp.period_start)::date=selected.commission_month
                OR date_trunc('month', paid_ct.commission_month)::date=selected.commission_month),0) AS paid
       FROM candidate_groups selected
       LEFT JOIN commission_payments cp ON cp.salesperson_id=selected.salesperson_id AND cp.status <> 'voided'
       LEFT JOIN commission_transactions paid_ct ON paid_ct.id=cp.commission_transaction_id
       GROUP BY selected.salesperson_id, selected.commission_month
     ), payable_groups AS (
       SELECT selected.salesperson_id, selected.commission_month,
              LEAST(selected.selected_balance,
                    GREATEST(ledger.credits-ledger.deductions-COALESCE(payments.paid,0),0)) AS settleable_amount
       FROM candidate_groups selected
       JOIN period_ledger ledger USING (salesperson_id, commission_month)
       LEFT JOIN period_payments payments USING (salesperson_id, commission_month)
     )
     SELECT
       COALESCE(array_agg(id ORDER BY qualified_at DESC, created_at DESC)
         FILTER (WHERE transaction_status='pending'), '{}'::uuid[]) AS pending_ids,
       COALESCE(SUM(amount) FILTER (WHERE transaction_status='pending'), 0) AS pending_amount,
       COALESCE(array_agg(id ORDER BY qualified_at DESC, created_at DESC)
         FILTER (WHERE transaction_status IN ('approved','paid')
           AND (transaction_type IN ('earned','manual_add')
             OR (transaction_type='carry_forward' AND carry_forward_direction='credit'))
           AND amount-paid_amount-reversed_amount > 0.004
           AND EXISTS (SELECT 1 FROM payable_groups payable
                       WHERE payable.salesperson_id=candidates.salesperson_id
                         AND payable.commission_month=candidates.commission_month
                         AND payable.settleable_amount > 0.004)), '{}'::uuid[]) AS settleable_ids,
       COALESCE((SELECT SUM(settleable_amount) FROM payable_groups), 0) AS settleable_amount
     FROM candidates`,
    params
  )
  params.push(pageSize, (page - 1) * pageSize)
  const result = await query(
    `SELECT ct.id, ct.salesperson_id, ct.order_id, sp.full_name AS salesperson_name,
            COALESCE(o.order_number, 'Manual adjustment') AS order_number,
            COALESCE(p.name, 'Commission adjustment') AS product_name,
            ct.eligible_quantity, ct.rate_per_item, ct.amount, ct.transaction_type, ct.carry_forward_direction,
            ct.transaction_status, ct.policy_date, ct.qualification_date, ct.qualified_at, ct.commission_month, ct.source_period,
            ct.reason, approver.full_name AS approved_by_name, ct.approved_at,
             COALESCE((SELECT SUM(cp.paid_amount) FROM commission_payments cp WHERE cp.commission_transaction_id = ct.id AND cp.status <> 'voided'), 0) AS paid_amount,
             (SELECT MAX(cp.paid_at) FROM commission_payments cp WHERE cp.commission_transaction_id = ct.id AND cp.status <> 'voided') AS last_paid_at,
            (SELECT string_agg(
              CONCAT(COALESCE(cp.payment_method::text, 'payment'), ': ', COALESCE(NULLIF(cp.reference, ''), 'no reference'), ' — ', cp.paid_amount),
              '; ' ORDER BY cp.paid_at DESC, cp.created_at DESC
              ) FROM commission_payments cp WHERE cp.commission_transaction_id = ct.id AND cp.status <> 'voided') AS payment_references,
             COALESCE((SELECT json_agg(json_build_object(
               'id', cp.id,
               'amount', cp.paid_amount,
               'method', cp.payment_method::text,
               'reference', cp.reference,
               'settledAt', cp.paid_at,
               'status', cp.status
             ) ORDER BY cp.paid_at DESC, cp.created_at DESC)
             FROM commission_payments cp
             WHERE cp.commission_transaction_id = ct.id AND cp.status <> 'voided'), '[]'::json) AS settlement_records,
            COALESCE((SELECT SUM(reversal.amount) FROM commission_transactions reversal
                      WHERE reversal.original_transaction_id = ct.id AND reversal.transaction_type = 'reversal'), 0) AS reversed_amount
     FROM commission_transactions ct
     JOIN users sp ON sp.id = ct.salesperson_id
     LEFT JOIN orders o ON o.id = ct.order_id
     LEFT JOIN products p ON p.id = ct.product_id
     LEFT JOIN users approver ON approver.id = ct.approved_by
     WHERE ${where}
     ORDER BY ct.qualified_at DESC, ct.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )
  const total = Number(count.rows[0]?.total || 0)
  const bulk = bulkSelectionResult.rows[0]
  return {
    data: result.rows,
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    bulkSelection: {
      pendingIds: bulk.pending_ids || [],
      pendingAmount: toNumber(bulk.pending_amount),
      settleableIds: bulk.settleable_ids || [],
      settleableAmount: toNumber(bulk.settleable_amount)
    }
  }
}

export async function getManagementCommissionSummary(dateFrom: string, dateTo: string) {
  const activityDate = (alias: string) => `(CASE
    WHEN ${alias}.transaction_type='earned'
      AND date_trunc('month', ${alias}.policy_date)::date=${alias}.commission_month THEN ${alias}.policy_date
    WHEN ${alias}.source_period IS NOT NULL AND ${alias}.commission_month=${alias}.source_period THEN ${alias}.commission_month
    ELSE ${alias}.qualification_date END)`
  const result = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'earned' THEN ct.amount ELSE 0 END), 0) AS total_earned,
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'reversal' THEN ct.amount ELSE 0 END), 0) AS total_reversals,
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'manual_add' THEN ct.amount ELSE 0 END), 0) AS total_manual_additions,
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'manual_deduct' THEN ct.amount ELSE 0 END), 0) AS total_manual_deductions,
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'carry_forward' AND ct.carry_forward_direction = 'credit' THEN ct.amount ELSE 0 END), 0) AS total_carry_forward_credits,
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'carry_forward' AND ct.carry_forward_direction = 'deduction' THEN ct.amount ELSE 0 END), 0) AS total_carry_forward_deductions,
       COALESCE((SELECT SUM(cp.paid_amount)
                 FROM commission_payments cp
                 LEFT JOIN commission_transactions paid_ct ON paid_ct.id = cp.commission_transaction_id
                  WHERE cp.status <> 'voided' AND ((cp.commission_transaction_id IS NOT NULL
                           AND ${activityDate('paid_ct')} >= $1::date AND ${activityDate('paid_ct')} <= $2::date)
                     OR (cp.commission_transaction_id IS NULL
                          AND cp.period_start >= $1::date AND cp.period_start <= $2::date))), 0) AS total_payments,
       COALESCE((SELECT SUM(cp.paid_amount)
                 FROM commission_payments cp
                 WHERE cp.status <> 'voided'
                   AND cp.paid_at::date >= $1::date AND cp.paid_at::date <= $2::date), 0) AS settled_in_period,
       COALESCE(SUM(CASE
         WHEN ct.transaction_status IN ('approved','paid','reversed')
          AND ct.transaction_type IN ('earned','manual_add') THEN ct.amount
         WHEN ct.transaction_status IN ('approved','paid','reversed')
          AND ct.transaction_type = 'carry_forward' AND ct.carry_forward_direction = 'credit' THEN ct.amount
         ELSE 0 END), 0) AS approved_credits,
       COALESCE(SUM(CASE
         WHEN ct.transaction_type = 'reversal' THEN ct.amount
         WHEN ct.transaction_status IN ('approved','paid') AND ct.transaction_type = 'manual_deduct' THEN ct.amount
         WHEN ct.transaction_status IN ('approved','paid') AND ct.transaction_type = 'carry_forward' AND ct.carry_forward_direction = 'deduction' THEN ct.amount
         ELSE 0 END), 0) AS approved_deductions,
       (SELECT COUNT(DISTINCT activity.salesperson_id) FROM (
          SELECT earning.salesperson_id FROM commission_transactions earning
          WHERE ${activityDate('earning')} >= $1::date AND ${activityDate('earning')} <= $2::date
          UNION
          SELECT payment.salesperson_id FROM commission_payments payment
          WHERE payment.status <> 'voided'
            AND payment.paid_at::date >= $1::date AND payment.paid_at::date <= $2::date
        ) activity) AS salesperson_count,
       COUNT(DISTINCT ct.order_id) AS order_count,
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'earned' THEN ct.eligible_quantity ELSE 0 END), 0)::int AS item_count
     FROM commission_transactions ct
     WHERE ${activityDate('ct')} >= $1::date AND ${activityDate('ct')} <= $2::date`,
    [dateFrom, dateTo]
  )
  const row = result.rows[0]
  const approvedBalance = toNumber(row.approved_credits) - toNumber(row.approved_deductions) - toNumber(row.total_payments)
  const netCommission = toNumber(row.total_earned) - toNumber(row.total_reversals) + toNumber(row.total_manual_additions) - toNumber(row.total_manual_deductions) + toNumber(row.total_carry_forward_credits) - toNumber(row.total_carry_forward_deductions)
  const outstandingAmount = netCommission - toNumber(row.total_payments)
  return {
    totalEarned: toNumber(row.total_earned),
    totalReversals: toNumber(row.total_reversals),
    totalManualAdditions: toNumber(row.total_manual_additions),
    totalManualDeductions: toNumber(row.total_manual_deductions),
    totalCarryForwardCredits: toNumber(row.total_carry_forward_credits),
    totalCarryForwardDeductions: toNumber(row.total_carry_forward_deductions),
    totalPayments: toNumber(row.total_payments),
    settledInPeriod: toNumber(row.settled_in_period),
    approvedUnpaid: Math.max(0, approvedBalance),
    approvedPayable: Math.max(0, approvedBalance),
    pendingAmount: outstandingAmount - approvedBalance,
    outstandingAmount,
    netCommission,
    recoveryDue: Math.max(0, -approvedBalance),
    salespersonCount: Number(row.salesperson_count || 0),
    orderCount: Number(row.order_count || 0),
    itemCount: Number(row.item_count || 0)
  }
}

export async function getManagementCommissionBySalesperson(dateFrom: string, dateTo: string) {
  const activityDate = (alias: string) => `(CASE
    WHEN ${alias}.transaction_type='earned'
      AND date_trunc('month', ${alias}.policy_date)::date=${alias}.commission_month THEN ${alias}.policy_date
    WHEN ${alias}.source_period IS NOT NULL AND ${alias}.commission_month=${alias}.source_period THEN ${alias}.commission_month
    ELSE ${alias}.qualification_date END)`
  const [result, settlementsResult] = await Promise.all([query(
    `SELECT u.id AS salesperson_id, u.full_name, u.email,
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'earned' THEN ct.amount ELSE 0 END), 0) AS gross_earned,
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'reversal' THEN ct.amount ELSE 0 END), 0) AS reversals,
       COALESCE(SUM(CASE
         WHEN ct.transaction_status IN ('approved','paid','reversed') AND ct.transaction_type IN ('earned','manual_add') THEN ct.amount
         WHEN ct.transaction_status IN ('approved','paid','reversed') AND ct.transaction_type = 'carry_forward' AND ct.carry_forward_direction = 'credit' THEN ct.amount
         ELSE 0 END), 0) AS approved_credits,
       COALESCE(SUM(CASE
         WHEN ct.transaction_type = 'reversal' THEN ct.amount
         WHEN ct.transaction_status IN ('approved','paid') AND ct.transaction_type = 'manual_deduct' THEN ct.amount
         WHEN ct.transaction_status IN ('approved','paid') AND ct.transaction_type = 'carry_forward' AND ct.carry_forward_direction = 'deduction' THEN ct.amount
         ELSE 0 END), 0) AS approved_deductions,
       COALESCE(SUM(CASE
         WHEN ct.transaction_type IN ('earned','manual_add') THEN ct.amount
         WHEN ct.transaction_type IN ('reversal','manual_deduct') THEN -ct.amount
         WHEN ct.transaction_type = 'carry_forward' AND ct.carry_forward_direction = 'credit' THEN ct.amount
         WHEN ct.transaction_type = 'carry_forward' AND ct.carry_forward_direction = 'deduction' THEN -ct.amount
         ELSE 0 END), 0) AS net_commission,
       COUNT(DISTINCT CASE WHEN ct.transaction_type = 'earned' THEN ct.order_id END)::int AS order_count,
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'earned' THEN ct.eligible_quantity ELSE 0 END), 0)::int AS eligible_quantity,
       COALESCE((SELECT SUM(cp.paid_amount)
                 FROM commission_payments cp
                 LEFT JOIN commission_transactions paid_ct ON paid_ct.id = cp.commission_transaction_id
                  WHERE cp.salesperson_id = u.id AND cp.status <> 'voided'
                   AND ((cp.commission_transaction_id IS NOT NULL
                         AND ${activityDate('paid_ct')} >= $1::date AND ${activityDate('paid_ct')} <= $2::date)
                     OR (cp.commission_transaction_id IS NULL
                         AND cp.period_start >= $1::date AND cp.period_start <= $2::date))), 0) AS paid
     FROM commission_transactions ct
     JOIN users u ON u.id = ct.salesperson_id
     WHERE ${activityDate('ct')} >= $1::date AND ${activityDate('ct')} <= $2::date
     GROUP BY u.id, u.full_name, u.email
     ORDER BY net_commission DESC`,
    [dateFrom, dateTo]
  ), query(
    `SELECT cp.salesperson_id, u.full_name, u.email,
            COALESCE(SUM(cp.paid_amount), 0) AS settled_in_period
     FROM commission_payments cp
     JOIN users u ON u.id = cp.salesperson_id
     WHERE cp.status <> 'voided'
       AND cp.paid_at::date >= $1::date AND cp.paid_at::date <= $2::date
     GROUP BY cp.salesperson_id, u.full_name, u.email`,
    [dateFrom, dateTo]
  )])
  const settlements = new Map(settlementsResult.rows.map(row => [row.salesperson_id, row]))
  const earningRows = result.rows.map(row => {
    const netCommission = toNumber(row.net_commission)
    const paid = toNumber(row.paid)
    const outstandingAmount = netCommission - paid
    const approvedBalance = toNumber(row.approved_credits) - toNumber(row.approved_deductions) - paid
    return {
      salespersonId: row.salesperson_id,
      fullName: row.full_name,
      email: row.email,
      orderCount: Number(row.order_count || 0),
      eligibleQuantity: Number(row.eligible_quantity || 0),
      grossEarned: toNumber(row.gross_earned),
      reversals: toNumber(row.reversals),
      netCommission,
      paid,
      settledInPeriod: toNumber(settlements.get(row.salesperson_id)?.settled_in_period),
      outstandingAmount,
      payableAmount: Math.max(0, approvedBalance),
      approvedPayable: Math.max(0, approvedBalance),
      pendingAmount: outstandingAmount - approvedBalance,
      recoveryDue: Math.max(0, -approvedBalance)
    }
  })
  const existingIds = new Set(earningRows.map(row => row.salespersonId))
  for (const row of settlementsResult.rows) {
    if (existingIds.has(row.salesperson_id)) continue
    earningRows.push({
      salespersonId: row.salesperson_id,
      fullName: row.full_name,
      email: row.email,
      orderCount: 0,
      eligibleQuantity: 0,
      grossEarned: 0,
      reversals: 0,
      netCommission: 0,
      paid: 0,
      settledInPeriod: toNumber(row.settled_in_period),
      outstandingAmount: 0,
      payableAmount: 0,
      approvedPayable: 0,
      pendingAmount: 0,
      recoveryDue: 0
    })
  }
  return earningRows.sort((a, b) => b.settledInPeriod - a.settledInPeriod || b.netCommission - a.netCommission || a.fullName.localeCompare(b.fullName))
}

export async function getManagementCommissionSettlements(
  dateFrom: string,
  dateTo: string,
  page: number,
  pageSize: number,
  salespersonId?: string
) {
  const params: any[] = [dateFrom, dateTo]
  const conditions = ["cp.status <> 'voided'", 'cp.paid_at::date >= $1::date', 'cp.paid_at::date <= $2::date']
  if (salespersonId) {
    params.push(salespersonId)
    conditions.push(`cp.salesperson_id = $${params.length}`)
  }
  const where = conditions.join(' AND ')
  const count = await query(
    `SELECT COUNT(*)::int AS total, COALESCE(SUM(cp.paid_amount), 0) AS total_amount
     FROM commission_payments cp WHERE ${where}`,
    params
  )
  params.push(pageSize, (page - 1) * pageSize)
  const result = await query(
    `SELECT cp.id, cp.commission_transaction_id, cp.salesperson_id,
            sp.full_name AS salesperson_name,
            COALESCE(o.order_number, 'Commission adjustment') AS order_number,
            COALESCE(p.name, 'Commission adjustment') AS product_name,
            ct.qualification_date AS earned_date, ct.commission_month,
            cp.paid_amount, cp.payment_method::text AS payment_method,
            cp.reference, cp.paid_at, cp.notes, cp.status,
            payer.full_name AS recorded_by_name
     FROM commission_payments cp
     JOIN users sp ON sp.id = cp.salesperson_id
     LEFT JOIN commission_transactions ct ON ct.id = cp.commission_transaction_id
     LEFT JOIN orders o ON o.id = ct.order_id
     LEFT JOIN products p ON p.id = ct.product_id
     LEFT JOIN users payer ON payer.id = cp.paid_by
     WHERE ${where}
     ORDER BY cp.paid_at DESC, cp.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )
  const total = Number(count.rows[0]?.total || 0)
  return {
    data: result.rows,
    totalAmount: toNumber(count.rows[0]?.total_amount),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) }
  }
}

async function approveCommissionWithClient(client: DbExecutor, transactionId: string, userId: string | null) {
    const existing = await client.query(
      `SELECT id, salesperson_id, commission_month
       FROM commission_transactions
       WHERE id = $1 AND transaction_status = 'pending'
       FOR UPDATE`,
      [transactionId]
    )
    const commission = existing.rows[0]
    if (!commission || (userId && commission.salesperson_id === userId)) return null
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [commission.salesperson_id, dateOnly(commission.commission_month)]
    )
    const closedPeriod = await client.query(
      `SELECT id FROM commission_period_closures
       WHERE period_start = $1::date AND status = 'closed'`,
      [commission.commission_month]
    )
    if (closedPeriod.rows.length > 0) {
      throw Object.assign(new Error(`Commission period ${commission.commission_month} is closed and cannot be approved`), { statusCode: 409 })
    }
    const result = await client.query(
      `UPDATE commission_transactions SET transaction_status = 'approved', approved_by = $1, approved_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [userId, transactionId]
    )
    await logAudit({
      client,
      userId,
      action: 'commission_approved',
      entityType: 'commission_transaction',
      entityId: transactionId,
      newValues: { transaction_status: 'approved' }
    })
    return result.rows[0] || null
}

export async function approveCommission(transactionId: string, userId: string | null) {
  return transaction(client => approveCommissionWithClient(client, transactionId, userId))
}

export async function approveCommissionBulk(transactionIds: string[], userId: string | null) {
  const uniqueIds = [...new Set(transactionIds)].sort()
  if (uniqueIds.length === 0) {
    throw Object.assign(new Error('Select at least one pending commission transaction to approve'), { statusCode: 400 })
  }
  // Approvals are one management decision, so commit every selected row or
  // roll the complete batch back when any row is no longer pending/eligible.
  return transaction(async client => {
    const results = []
    for (const transactionId of uniqueIds) {
      const result = await approveCommissionWithClient(client, transactionId, userId)
      if (!result) {
        throw Object.assign(new Error(`Transaction ${transactionId} was not found, is no longer pending, or cannot be self-approved`), { statusCode: 409 })
      }
      results.push(result)
    }
    return { approvedCount: results.length, transactions: results }
  })
}

export interface CommissionPaymentInput {
  amount?: number
  paymentMethod: 'cash' | 'mpesa' | 'bank_transfer' | 'payroll'
  reference?: string | null
  notes?: string | null
  idempotencyKey?: string | null
  settledAt?: string | null
}

interface NormalizedCommissionPaymentInput extends CommissionPaymentInput {
  reference: string | null
  idempotencyKey: string
  settledAt: string
}

function normalizeCommissionPaymentInput(input: CommissionPaymentInput, idempotencyKeyOverride?: string): NormalizedCommissionPaymentInput {
  if (!['cash', 'mpesa', 'bank_transfer', 'payroll'].includes(input.paymentMethod)) {
    throw Object.assign(new Error('Settlement method must be cash, M-PESA, bank transfer, or salary / payroll'), { statusCode: 400 })
  }
  const reference = String(input.reference || '').trim() || null
  const suppliedIdempotencyKey = String(input.idempotencyKey || '').trim() || null
  if (['mpesa', 'bank_transfer', 'payroll'].includes(input.paymentMethod) && !reference) {
    throw Object.assign(new Error('A reference is required for M-PESA, bank, and salary / payroll settlements'), { statusCode: 400 })
  }
  if (input.paymentMethod === 'cash' && !suppliedIdempotencyKey) {
    throw Object.assign(new Error('A cash settlement confirmation key is required to prevent a duplicate record'), { statusCode: 400 })
  }
  const idempotencyKey = idempotencyKeyOverride || (input.paymentMethod === 'cash'
    ? `cash:${suppliedIdempotencyKey}`
    : `${input.paymentMethod}:${reference!.toUpperCase()}`)
  if (idempotencyKey.length > 128) {
    throw Object.assign(new Error('Settlement reference or confirmation key is too long'), { statusCode: 400 })
  }
  const rawSettledAt = String(input.settledAt || '').trim()
  let settledAt = normalizeNairobiTimestamp(new Date())
  if (rawSettledAt) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawSettledAt)) {
      throw Object.assign(new Error('Settlement date must use YYYY-MM-DD'), { statusCode: 400 })
    }
    if (rawSettledAt > nairobiDate(new Date())) {
      throw Object.assign(new Error('Settlement date cannot be in the future'), { statusCode: 400 })
    }
    settledAt = `${rawSettledAt} 12:00:00.000`
  }
  return { ...input, reference, idempotencyKey, settledAt }
}

async function payCommissionWithClient(
  client: DbExecutor,
  transactionId: string,
  userId: string | null,
  input: NormalizedCommissionPaymentInput,
  skipWhenNoCapacity = false,
  allowSelfPayment = false
) {
    const transactionResult = await client.query(
      `SELECT * FROM commission_transactions
       WHERE id = $1 AND transaction_status IN ('approved','paid')
         AND (
           transaction_type IN ('earned','manual_add')
           OR (transaction_type = 'carry_forward' AND carry_forward_direction = 'credit')
         )
       FOR UPDATE`,
      [transactionId]
    )
    const commission = transactionResult.rows[0]
    if (!commission) return null
    if (!allowSelfPayment && userId && commission.salesperson_id === userId) {
      throw Object.assign(new Error('You cannot record payment for your own commission'), { statusCode: 403 })
    }
    // All payment capacity is period-wide. This lock serializes payment
    // attempts against different credit entries for the same salesperson/month
    // so a manual deduction or reversal cannot be bypassed by concurrency.
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [commission.salesperson_id, dateOnly(commission.commission_month)]
    )
    const priorAttempt = await client.query(
      'SELECT * FROM commission_payments WHERE idempotency_key = $1 FOR UPDATE',
      [input.idempotencyKey]
    )
    if (priorAttempt.rows.length > 0) {
      const payment = priorAttempt.rows[0]
      if (payment.commission_transaction_id !== transactionId) {
        throw Object.assign(new Error('This settlement reference or confirmation key was already used for another commission settlement'), { statusCode: 409 })
      }
      if (payment.status === 'voided') {
        throw Object.assign(new Error('This settlement reference belongs to a voided record; use a new reference'), { statusCode: 409 })
      }
      return {
        transaction: commission,
        payment,
        remainingAmount: null,
        periodPayableRemaining: null,
        idempotent: true
      }
    }
    const closedPeriod = await client.query(
      `SELECT id FROM commission_period_closures
       WHERE period_start = $1::date AND status = 'closed'`,
      [commission.commission_month]
    )
    if (closedPeriod.rows.length > 0) {
      throw Object.assign(new Error(`Commission period ${commission.commission_month} is closed; pay its carry-forward entry in the next open period instead`), { statusCode: 409 })
    }
    const paidResult = await client.query(
      "SELECT COALESCE(SUM(paid_amount), 0) AS paid FROM commission_payments WHERE commission_transaction_id = $1 AND status <> 'voided'",
      [transactionId]
    )
    const alreadyPaid = toNumber(paidResult.rows[0]?.paid)
    const reversalResult = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS reversed_amount
       FROM commission_transactions
       WHERE original_transaction_id = $1 AND transaction_type = 'reversal'`,
      [transactionId]
    )
    const reversedAmount = toNumber(reversalResult.rows[0]?.reversed_amount)
    const directPayable = Math.max(0, toNumber(commission.amount) - reversedAmount)
    const directRemaining = Math.max(0, directPayable - alreadyPaid)

    // Manual deductions apply at period level; a payment must never bypass them.
    // Reversals are included regardless of review state so a newly returned order
    // cannot be paid while a manager is reviewing the counter-entry.
    const periodResult = await client.query(
      `SELECT
         COALESCE(SUM(CASE
           WHEN transaction_type IN ('earned', 'manual_add')
            AND transaction_status IN ('approved', 'paid', 'reversed') THEN amount
           WHEN transaction_type = 'carry_forward' AND carry_forward_direction = 'credit'
            AND transaction_status IN ('approved', 'paid', 'reversed') THEN amount
           ELSE 0 END), 0) AS approved_credits,
         COALESCE(SUM(CASE
           WHEN transaction_type = 'reversal' THEN amount
           WHEN transaction_type = 'manual_deduct' AND transaction_status IN ('approved', 'paid') THEN amount
           WHEN transaction_type = 'carry_forward' AND carry_forward_direction = 'deduction'
            AND transaction_status IN ('approved', 'paid') THEN amount
           ELSE 0 END), 0) AS deductions,
         COALESCE((SELECT SUM(cp.paid_amount)
           FROM commission_payments cp
           LEFT JOIN commission_transactions paid_ct ON paid_ct.id = cp.commission_transaction_id
            WHERE cp.salesperson_id = $1
              AND cp.status <> 'voided'
              AND (date_trunc('month', cp.period_start)::date = $2::date
                  OR date_trunc('month', paid_ct.commission_month)::date = $2::date)), 0) AS paid
       FROM commission_transactions
       WHERE salesperson_id = $1 AND commission_month = $2`,
      [commission.salesperson_id, commission.commission_month]
    )
    const period = periodResult.rows[0]
    const periodAvailable = Math.max(0, toNumber(period.approved_credits) - toNumber(period.deductions) - toNumber(period.paid))
    const remaining = Math.min(directRemaining, periodAvailable)
    if (skipWhenNoCapacity && input.amount === undefined && remaining < 0.01) {
      return {
        transaction: commission,
        payment: null,
        remainingAmount: directRemaining,
        periodPayableRemaining: periodAvailable,
        skipped: true
      }
    }
    const rawRequestedAmount = input.amount === undefined ? remaining : Number(input.amount)
    const requestedAmount = amountToCents(rawRequestedAmount)
    if (!Number.isFinite(rawRequestedAmount) || Math.abs(rawRequestedAmount - requestedAmount) > 0.000001 || requestedAmount <= 0 || requestedAmount > remaining + 0.000001) {
      throw Object.assign(new Error(`Payment amount must be greater than zero and no more than ${remaining}`), { statusCode: 400 })
    }

    const paymentResult = await client.query(
      `INSERT INTO commission_payments
        (commission_transaction_id, salesperson_id, period_start, period_end, total_amount, paid_amount,
          payment_method, reference, paid_by, paid_at, notes, idempotency_key, status, created_by, created_at)
       VALUES ($1, $2, $3, ($3::date + INTERVAL '1 month - 1 day')::date, $4, $5,
               $6, $7, $8, $9::timestamp, $10, $11, $12, $8, NOW())
       RETURNING *`,
      [transactionId, commission.salesperson_id, commission.commission_month, directPayable, requestedAmount,
       input.paymentMethod, input.reference, userId, input.settledAt, input.notes || null, input.idempotencyKey,
       alreadyPaid + requestedAmount >= directPayable ? 'paid' : 'partial']
    )
    const fullyPaid = alreadyPaid + requestedAmount >= directPayable
    const updated = await client.query(
      `UPDATE commission_transactions
       SET transaction_status = CASE WHEN $2 THEN 'paid' ELSE 'approved' END
       WHERE id = $1 RETURNING *`,
      [transactionId, fullyPaid]
    )
    await logAudit({
      client,
      userId,
      action: 'commission_paid',
      entityType: 'commission_transaction',
      entityId: transactionId,
      newValues: {
        payment_id: paymentResult.rows[0].id,
        amount: requestedAmount,
        payment_method: input.paymentMethod,
        reference: input.reference,
        settled_at: input.settledAt,
        fully_paid: fullyPaid,
        reversal_offset: reversedAmount
      }
    })
    return {
      transaction: updated.rows[0],
      payment: paymentResult.rows[0],
      remainingAmount: Math.max(0, directRemaining - requestedAmount),
      periodPayableRemaining: Math.max(0, periodAvailable - requestedAmount)
    }
}

export async function payCommission(transactionId: string, userId: string | null, input: CommissionPaymentInput) {
  const normalized = normalizeCommissionPaymentInput(input)
  return transaction(client => payCommissionWithClient(client, transactionId, userId, normalized))
}

export async function payCommissionBulk(transactionIds: string[], userId: string | null, input: CommissionPaymentInput) {
  if (!Array.isArray(transactionIds) || transactionIds.length === 0) {
    throw Object.assign(new Error('Select at least one commission transaction to pay'), { statusCode: 400 })
  }
  const reference = String(input.reference || '').trim() || null
  const suppliedIdempotencyKey = String(input.idempotencyKey || '').trim() || null
  const bulkIdempotencyKey = input.paymentMethod === 'cash'
    ? `cash:${suppliedIdempotencyKey}`
    : `${input.paymentMethod}:${String(reference || '').toUpperCase()}`

  // One database transaction makes a salary batch all-or-nothing. A failure
  // on any selected ledger row rolls back every settlement in the batch.
  return transaction(async client => {
    const results = []
    for (const transactionId of transactionIds) {
      const normalized = normalizeCommissionPaymentInput(
        { ...input, reference, idempotencyKey: suppliedIdempotencyKey },
        `${bulkIdempotencyKey}:${transactionId}`
      )
      const result = await payCommissionWithClient(client, transactionId, userId, normalized, true)
      if (!result) {
        throw Object.assign(new Error(`Transaction ${transactionId} was not found or not payable`), { statusCode: 404 })
      }
      results.push(result)
    }
    return { bulkReference: bulkIdempotencyKey, results }
  })
}

export async function revokeCommissionApproval(transactionId: string, reason: string, userId: string | null) {
  const revokeReason = String(reason || '').trim()
  if (!revokeReason) throw Object.assign(new Error('A reason is required to revoke approval'), { statusCode: 400 })
  return transaction(async client => {
    const existing = await client.query(
      `SELECT * FROM commission_transactions
       WHERE id = $1 AND transaction_type <> 'carry_forward'
       FOR UPDATE`,
      [transactionId]
    )
    const commission = existing.rows[0]
    if (!commission) return null
    await lockCommissionPeriod(client, commission.commission_month)
    const closed = await client.query(
      `SELECT id FROM commission_period_closures WHERE period_start=$1::date AND status='closed'`,
      [commission.commission_month]
    )
    if (closed.rows.length > 0) throw Object.assign(new Error('A closed-period approval cannot be revoked; reopen the period or use a current correction'), { statusCode: 409 })
    const settlements = await client.query(
      `SELECT COUNT(*)::int AS count FROM commission_payments
       WHERE commission_transaction_id=$1 AND status <> 'voided'`,
      [transactionId]
    )
    if (Number(settlements.rows[0]?.count || 0) > 0) {
      throw Object.assign(new Error('Void the recorded settlement before revoking this approval'), { statusCode: 409 })
    }
    if (commission.transaction_status !== 'approved') {
      throw Object.assign(new Error('Only an approved, unsettled commission can have its approval revoked'), { statusCode: 409 })
    }
    const updated = await client.query(
      `UPDATE commission_transactions
       SET transaction_status='pending', approved_by=NULL, approved_at=NULL,
           reason=CASE WHEN reason IS NULL OR reason='' THEN $2 ELSE reason || E'\n[Approval revoked] ' || $2 END
       WHERE id=$1 RETURNING *`,
      [transactionId, revokeReason]
    )
    await logAudit({
      client, userId, action: 'commission_approval_revoked', entityType: 'commission_transaction', entityId: transactionId,
      oldValues: { transaction_status: 'approved', approved_by: commission.approved_by, approved_at: commission.approved_at },
      newValues: { transaction_status: 'pending', reason: revokeReason }
    })
    return updated.rows[0]
  })
}

export async function voidCommissionSettlement(paymentId: string, reason: string, userId: string | null) {
  const voidReason = String(reason || '').trim()
  if (!voidReason) throw Object.assign(new Error('A reason is required to void a settlement'), { statusCode: 400 })
  return transaction(async client => {
    const existing = await client.query(
      `SELECT cp.*, ct.commission_month, ct.amount AS transaction_amount, ct.transaction_status
       FROM commission_payments cp
       JOIN commission_transactions ct ON ct.id=cp.commission_transaction_id
       WHERE cp.id=$1 AND cp.status <> 'voided'
       FOR UPDATE OF cp, ct`,
      [paymentId]
    )
    const payment = existing.rows[0]
    if (!payment) return null
    await lockCommissionPeriod(client, payment.commission_month)
    const closed = await client.query(
      `SELECT id FROM commission_period_closures WHERE period_start=$1::date AND status='closed'`,
      [payment.commission_month]
    )
    if (closed.rows.length > 0) throw Object.assign(new Error('A settlement in a closed period cannot be voided until that period is safely reopened'), { statusCode: 409 })
    await client.query(
      `UPDATE commission_payments
       SET status='voided', voided_by=$2, voided_at=NOW(), void_reason=$3
       WHERE id=$1`,
      [paymentId, userId, voidReason]
    )
    const activePaid = await client.query(
      `SELECT COALESCE(SUM(paid_amount),0) AS paid FROM commission_payments
       WHERE commission_transaction_id=$1 AND status <> 'voided'`,
      [payment.commission_transaction_id]
    )
    const reversed = await client.query(
      `SELECT COALESCE(SUM(amount),0) AS amount FROM commission_transactions
       WHERE original_transaction_id=$1 AND transaction_type='reversal'`,
      [payment.commission_transaction_id]
    )
    const payable = Math.max(0, toNumber(payment.transaction_amount) - toNumber(reversed.rows[0]?.amount))
    const paid = toNumber(activePaid.rows[0]?.paid)
    const transactionStatus = paid + 0.000001 >= payable ? 'paid' : 'approved'
    const updated = await client.query(
      `UPDATE commission_transactions SET transaction_status=$2 WHERE id=$1 RETURNING *`,
      [payment.commission_transaction_id, transactionStatus]
    )
    await logAudit({
      client, userId, action: 'commission_settlement_voided', entityType: 'commission_payment', entityId: paymentId,
      oldValues: { status: payment.status, paid_amount: payment.paid_amount, reference: payment.reference },
      newValues: { status: 'voided', reason: voidReason, commission_transaction_status: transactionStatus }
    })
    return { paymentId, transaction: updated.rows[0], activePaid: paid }
  })
}

export async function manualAdjustment(
  salespersonId: string,
  amount: number,
  adjustmentType: 'manual_add' | 'manual_deduct',
  reason: string,
  orderId: string | null,
  orderItemId: string | null,
  requestedPeriod: string,
  userId: string | null
) {
  const numericAmount = Number(amount)
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw Object.assign(new Error('Adjustment amount must be greater than zero'), { statusCode: 400 })
  }
  if (!String(reason || '').trim()) {
    throw Object.assign(new Error('Adjustment reason is required'), { statusCode: 400 })
  }
  if (userId && salespersonId === userId) {
    throw Object.assign(new Error('You cannot adjust your own commission'), { statusCode: 403 })
  }
  const sourcePeriod = normalizeCommissionPeriod(requestedPeriod).periodStart
  const now = new Date().toISOString()
  const currentDate = nairobiDate(now)
  const currentTimestamp = normalizeNairobiTimestamp(now)
  const currentMonth = currentDate.slice(0, 7) + '-01'
  const programme = await getProgrammeStateAsOf(now)
  if (!programme) throw Object.assign(new Error('Commission programme has not been configured'), { statusCode: 409 })

  return transaction(async client => {
    if (orderId) {
      const relatedOrder = await client.query('SELECT id, created_by FROM orders WHERE id = $1', [orderId])
      if (!relatedOrder.rows[0]) throw Object.assign(new Error('Related order was not found'), { statusCode: 400 })
      if (relatedOrder.rows[0].created_by && relatedOrder.rows[0].created_by !== salespersonId) {
        throw Object.assign(new Error('Related order belongs to a different salesperson'), { statusCode: 400 })
      }
    }
    const sourceClosure = await client.query(
      `SELECT id FROM commission_period_closures
       WHERE period_start = $1::date AND status = 'closed'`,
      [sourcePeriod]
    )
    const routedFromClosedPeriod = sourceClosure.rows.length > 0
    const targetMonth = routedFromClosedPeriod ? currentMonth : sourcePeriod
    const targetDate = targetMonth === currentMonth ? currentDate : targetMonth
    const targetTimestamp = targetMonth === currentMonth ? currentTimestamp : `${targetMonth} 00:00:00.000`
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [salespersonId, targetMonth]
    )
    const targetClosure = await client.query(
      `SELECT id FROM commission_period_closures
       WHERE period_start = $1::date AND status = 'closed'`,
      [targetMonth]
    )
    if (targetClosure.rows.length > 0) {
      throw Object.assign(new Error(`Commission period ${targetMonth} is closed; choose an open correction period`), { statusCode: 409 })
    }
    const recordedReason = routedFromClosedPeriod
      ? `[Correction for closed period ${sourcePeriod}] ${String(reason).trim()}`
      : String(reason).trim()
    const result = await client.query(
      `INSERT INTO commission_transactions
       (programme_id, salesperson_id, order_id, order_item_id, amount, transaction_type, transaction_status,
        qualification_date, qualified_at, commission_month, source_period, reason, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7::date, $8::timestamp, $9::date, $10::date, $11, $12, NOW())
       RETURNING id, amount`,
      [programme.id, salespersonId, orderId, orderItemId, numericAmount, adjustmentType, targetDate, targetTimestamp, targetMonth, sourcePeriod, recordedReason, userId]
    )
    await logAudit({
      client,
      userId,
      action: 'commission_adjusted',
      entityType: 'commission_transaction',
      entityId: result.rows[0].id,
      newValues: {
        salesperson_id: salespersonId,
        amount: numericAmount,
        adjustment_type: adjustmentType,
        reason: recordedReason,
        order_id: orderId,
        order_item_id: orderItemId,
        source_period: sourcePeriod,
        target_period: targetMonth,
        routed_from_closed_period: routedFromClosedPeriod
      }
    })
    return result.rows[0]
  })
}

function normalizeCommissionPeriod(value: string): { periodStart: string; periodEnd: string; nextPeriodStart: string } {
  const raw = String(value || '').trim()
  const matched = /^(\d{4})-(\d{2})(?:-01)?$/.exec(raw)
  if (!matched) {
    throw Object.assign(new Error('Period must use YYYY-MM or YYYY-MM-01'), { statusCode: 400 })
  }
  const year = Number(matched[1])
  const month = Number(matched[2])
  if (!Number.isInteger(year) || month < 1 || month > 12) {
    throw Object.assign(new Error('Period must be a valid calendar month'), { statusCode: 400 })
  }
  const periodStart = `${matched[1]}-${matched[2]}-01`
  const periodEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
  const nextPeriodStart = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10)
  return { periodStart, periodEnd, nextPeriodStart }
}

/**
 * Commission periods are Nairobi calendar months. Keep the advisory-lock key
 * in one place so closing a month and any writer that can affect that month
 * always serialize against exactly the same lock.
 */
export function commissionPeriodForTimestamp(value: string | Date): string {
  return `${nairobiDate(value).slice(0, 7)}-01`
}

export async function lockCommissionPeriod(client: DbExecutor, period: string): Promise<string> {
  const { periodStart } = normalizeCommissionPeriod(period)
  await client.query("SELECT pg_advisory_xact_lock(hashtext('commission-period-close:' || $1))", [periodStart])
  return periodStart
}

function amountToCents(value: unknown): number {
  return Math.round(toNumber(value) * 100) / 100
}

export interface CommissionPeriodClosureBalance {
  id?: string
  salespersonId: string
  salespersonName?: string
  programmeId?: string | null
  approvedCredits: number
  approvedDeductions: number
  paidAmount: number
  closingBalance: number
  sourceOffsetTransactionId: string | null
  carryForwardTransactionId: string | null
}

export interface CommissionPeriodClosure {
  id: string
  periodStart: string
  periodEnd: string
  status: 'closing' | 'closed' | 'reopened'
  reason: string
  closedBy: string | null
  closedByName?: string | null
  closedAt: string | null
  reopenedBy?: string | null
  reopenedByName?: string | null
  reopenedAt?: string | null
  reopenReason?: string | null
  createdAt: string
  totalUnpaid: number
  totalRecovery: number
  balances: CommissionPeriodClosureBalance[]
}

export interface CommissionPeriodReadiness {
  periodStart: string
  periodEnd: string
  nextPeriodStart: string
  periodStatus: 'open' | 'closing' | 'closed' | 'reopened'
  completedMonth: boolean
  isReadyToClose: boolean
  priorUnclosedPeriod: string | null
  pendingCount: number
  pendingTransactions: any[]
  totalApprovedCredits: number
  totalApprovedDeductions: number
  totalSettled: number
  totalUnpaid: number
  totalRecovery: number
  blockers: string[]
  balances: CommissionPeriodClosureBalance[]
}

function periodClosureBalanceFromRow(row: any): CommissionPeriodClosureBalance {
  return {
    id: row.id,
    salespersonId: row.salesperson_id,
    salespersonName: row.salesperson_name,
    programmeId: row.programme_id || null,
    approvedCredits: amountToCents(row.approved_credits),
    approvedDeductions: amountToCents(row.approved_deductions),
    paidAmount: amountToCents(row.paid_amount),
    closingBalance: amountToCents(row.closing_balance),
    sourceOffsetTransactionId: row.source_offset_transaction_id || null,
    carryForwardTransactionId: row.carry_forward_transaction_id || null
  }
}

async function commissionPeriodBalanceRows(client: DbExecutor, periodStart: string) {
  return client.query(
    `WITH ledger AS (
       SELECT ct.salesperson_id,
              (array_agg(ct.programme_id ORDER BY ct.qualified_at DESC, ct.created_at DESC))[1] AS programme_id,
              COALESCE(SUM(CASE
                WHEN ct.transaction_type IN ('earned', 'manual_add')
                  AND ct.transaction_status IN ('approved', 'paid', 'reversed') THEN ct.amount
                WHEN ct.transaction_type = 'carry_forward' AND ct.carry_forward_direction = 'credit'
                  AND ct.transaction_status IN ('approved', 'paid', 'reversed') THEN ct.amount
                ELSE 0 END), 0) AS approved_credits,
              COALESCE(SUM(CASE
                WHEN ct.transaction_type = 'reversal' THEN ct.amount
                WHEN ct.transaction_type = 'manual_deduct'
                  AND ct.transaction_status IN ('approved', 'paid') THEN ct.amount
                WHEN ct.transaction_type = 'carry_forward' AND ct.carry_forward_direction = 'deduction'
                  AND ct.transaction_status IN ('approved', 'paid') THEN ct.amount
                ELSE 0 END), 0) AS approved_deductions
       FROM commission_transactions ct
       WHERE ct.commission_month = $1::date
       GROUP BY ct.salesperson_id
     ), payments AS (
       SELECT COALESCE(ct.salesperson_id, cp.salesperson_id) AS salesperson_id,
              COALESCE(SUM(cp.paid_amount), 0) AS paid_amount
       FROM commission_payments cp
       LEFT JOIN commission_transactions ct ON ct.id = cp.commission_transaction_id
       WHERE cp.status <> 'voided'
         AND (date_trunc('month', cp.period_start)::date = $1::date
           OR date_trunc('month', ct.commission_month)::date = $1::date)
       GROUP BY COALESCE(ct.salesperson_id, cp.salesperson_id)
     )
     SELECT COALESCE(ledger.salesperson_id, payments.salesperson_id) AS salesperson_id,
            salesperson.full_name AS salesperson_name,
            COALESCE(ledger.programme_id,
              (SELECT id FROM commission_programmes ORDER BY effective_from DESC, created_at DESC LIMIT 1)
            ) AS programme_id,
            COALESCE(ledger.approved_credits, 0) AS approved_credits,
            COALESCE(ledger.approved_deductions, 0) AS approved_deductions,
            COALESCE(payments.paid_amount, 0) AS paid_amount,
            COALESCE(ledger.approved_credits, 0) - COALESCE(ledger.approved_deductions, 0) - COALESCE(payments.paid_amount, 0) AS closing_balance
     FROM ledger
     FULL OUTER JOIN payments ON payments.salesperson_id = ledger.salesperson_id
     JOIN users salesperson ON salesperson.id = COALESCE(ledger.salesperson_id, payments.salesperson_id)
     ORDER BY salesperson.full_name`,
    [periodStart]
  )
}

async function firstPriorUnclosedCommissionPeriod(client: DbExecutor, periodStart: string): Promise<string | null> {
  const result = await client.query(
    `WITH evidence_periods AS (
       SELECT date_trunc('month', effective_from)::date AS period_start FROM commission_programmes
       UNION ALL
       SELECT date_trunc('month', commission_month)::date AS period_start FROM commission_transactions
       UNION ALL
       SELECT date_trunc('month', period_start)::date AS period_start FROM commission_payments
     ), timeline_start AS (
       SELECT MIN(period_start) AS period_start FROM evidence_periods WHERE period_start < $1::date
     ), candidate_periods AS (
       SELECT generated.period_start::date AS period_start
       FROM timeline_start
       CROSS JOIN LATERAL generate_series(
         timeline_start.period_start, ($1::date - INTERVAL '1 month')::date, INTERVAL '1 month'
       ) AS generated(period_start)
     )
     SELECT candidate.period_start
     FROM candidate_periods candidate
     LEFT JOIN commission_period_closures closure
       ON closure.period_start = candidate.period_start AND closure.status = 'closed'
     WHERE closure.id IS NULL
     ORDER BY candidate.period_start ASC
     LIMIT 1`,
    [periodStart]
  )
  return result.rows[0] ? dateOnly(result.rows[0].period_start) : null
}

export async function getCommissionPeriodReadiness(period: string): Promise<CommissionPeriodReadiness> {
  const { periodStart, periodEnd, nextPeriodStart } = normalizeCommissionPeriod(period)
  const [closure, pending, balancesResult] = await Promise.all([
    query(`SELECT status FROM commission_period_closures WHERE period_start=$1::date`, [periodStart]),
    query(
      `SELECT ct.id, ct.salesperson_id, salesperson.full_name AS salesperson_name,
              ct.transaction_type, ct.amount, ct.reason
       FROM commission_transactions ct
       JOIN users salesperson ON salesperson.id=ct.salesperson_id
       WHERE ct.commission_month=$1::date AND ct.transaction_status='pending'
       ORDER BY salesperson.full_name, ct.created_at`,
      [periodStart]
    ),
    commissionPeriodBalanceRows(defaultExecutor, periodStart)
  ])
  const priorUnclosedPeriod = await firstPriorUnclosedCommissionPeriod(defaultExecutor, periodStart)
  const completedMonth = periodEnd < nairobiDate(new Date())
  const periodStatus = (closure.rows[0]?.status || 'open') as CommissionPeriodReadiness['periodStatus']
  const balances: CommissionPeriodClosureBalance[] = balancesResult.rows.map((row: any) => ({
    ...periodClosureBalanceFromRow(row),
    sourceOffsetTransactionId: null,
    carryForwardTransactionId: null
  }))
  const blockers: string[] = []
  if (!completedMonth) blockers.push('Only a fully completed Nairobi calendar month can be closed.')
  if (periodStatus === 'closed') blockers.push('This period is already closed.')
  if (periodStatus === 'closing') blockers.push('This period is already being closed.')
  if (priorUnclosedPeriod) blockers.push(`Prior commission period ${priorUnclosedPeriod} must be closed first.`)
  if (pending.rows.length > 0) blockers.push(`${pending.rows.length} pending commission ledger item(s) require approval or resolution.`)
  return {
    periodStart, periodEnd, nextPeriodStart, periodStatus, completedMonth,
    isReadyToClose: blockers.length === 0,
    priorUnclosedPeriod,
    pendingCount: pending.rows.length,
    pendingTransactions: pending.rows.slice(0, 25),
    totalApprovedCredits: amountToCents(balances.reduce((sum, row) => sum + row.approvedCredits, 0)),
    totalApprovedDeductions: amountToCents(balances.reduce((sum, row) => sum + row.approvedDeductions, 0)),
    totalSettled: amountToCents(balances.reduce((sum, row) => sum + row.paidAmount, 0)),
    totalUnpaid: amountToCents(balances.reduce((sum, row) => sum + Math.max(0, row.closingBalance), 0)),
    totalRecovery: amountToCents(balances.reduce((sum, row) => sum + Math.max(0, -row.closingBalance), 0)),
    blockers,
    balances
  }
}

/**
 * Close a completed calendar month and certify its approved net commission as
 * paid through the business's external salary/payroll process. Positive
 * balances are settled effective on the final day of the source month. Only a
 * genuine recovery (deductions above earned commission) moves to the next
 * open period.
 */
export async function closeCommissionPeriod(
  period: string,
  reason: string,
  userId: string | null
): Promise<CommissionPeriodClosure> {
  const { periodStart, periodEnd, nextPeriodStart } = normalizeCommissionPeriod(period)
  const closeReason = String(reason || '').trim()
  if (!closeReason) {
    throw Object.assign(new Error('A close reason is required'), { statusCode: 400 })
  }
  if (periodEnd >= nairobiDate(new Date())) {
    throw Object.assign(new Error('Only a fully completed month can be closed'), { statusCode: 400 })
  }

  return transaction(async client => {
    // Hold all ledger writers while the balance is calculated and the period is
    // made immutable. This closes the race between a payment/return and month
    // close; waiting writers re-check the closed-period DB trigger on resume.
    await lockCommissionPeriod(client, periodStart)
    await client.query('LOCK TABLE commission_transactions, commission_payments IN SHARE ROW EXCLUSIVE MODE')

    const existing = await client.query(
      `SELECT id, status FROM commission_period_closures
       WHERE period_start = $1::date FOR UPDATE`,
      [periodStart]
    )
    if (existing.rows.length > 0 && existing.rows[0].status !== 'reopened') {
      throw Object.assign(new Error(`Commission period ${periodStart} has already been ${existing.rows[0].status}`), { statusCode: 409 })
    }
    const nextPeriod = await client.query(
      `SELECT id FROM commission_period_closures
       WHERE period_start = $1::date AND status = 'closed'`,
      [nextPeriodStart]
    )
    if (nextPeriod.rows.length > 0) {
      throw Object.assign(new Error(`Cannot close ${periodStart}: the carry-forward month ${nextPeriodStart} is already closed`), { statusCode: 409 })
    }
    // Periods form a continuous accounting timeline from the first commission
    // programme, ledger entry, or recorded commission payment. Skipping a
    // completed month would make carry-forwards land in an unreviewed period,
    // so refuse it even when that skipped month has a zero balance.
    const priorUnclosed = await client.query(
      `WITH evidence_periods AS (
         SELECT date_trunc('month', effective_from)::date AS period_start
         FROM commission_programmes
         UNION ALL
         SELECT date_trunc('month', commission_month)::date AS period_start FROM commission_transactions
         UNION ALL
         SELECT date_trunc('month', period_start)::date AS period_start FROM commission_payments
       ), timeline_start AS (
         SELECT MIN(period_start) AS period_start
         FROM evidence_periods
         WHERE period_start < $1::date
       ), candidate_periods AS (
         SELECT generated.period_start::date AS period_start
         FROM timeline_start
         CROSS JOIN LATERAL generate_series(
           timeline_start.period_start,
           ($1::date - INTERVAL '1 month')::date,
           INTERVAL '1 month'
         ) AS generated(period_start)
       )
       SELECT candidate.period_start
       FROM candidate_periods candidate
       LEFT JOIN commission_period_closures closure
         ON closure.period_start = candidate.period_start
        AND closure.status = 'closed'
       WHERE closure.id IS NULL
       ORDER BY candidate.period_start ASC
       LIMIT 1`,
      [periodStart]
    )
    if (priorUnclosed.rows.length > 0) {
      const missing = dateOnly(priorUnclosed.rows[0].period_start)
      throw Object.assign(new Error(`Cannot close ${periodStart}: prior commission period ${missing} must be closed first`), { statusCode: 409 })
    }

    const pending = await client.query(
      `SELECT id, salesperson_id, transaction_type, amount
       FROM commission_transactions
       WHERE commission_month = $1::date AND transaction_status = 'pending'
       ORDER BY created_at ASC
       LIMIT 25`,
      [periodStart]
    )
    if (pending.rows.length > 0) {
      const error = Object.assign(
        new Error(`Cannot close ${periodStart}: ${pending.rows.length}${pending.rows.length === 25 ? '+' : ''} pending commission ledger item(s) require approval or resolution`),
        { statusCode: 409, pendingTransactions: pending.rows }
      )
      throw error
    }

    const closureResult = existing.rows[0]?.status === 'reopened'
      ? await client.query(
          `UPDATE commission_period_closures
           SET status='closing', reason=$2, closed_by=$3, closed_at=NULL, created_at=NOW()
           WHERE id=$1 RETURNING *`,
          [existing.rows[0].id, closeReason, userId]
        )
      : await client.query(
          `INSERT INTO commission_period_closures
            (period_start, period_end, status, reason, closed_by, created_at)
           VALUES ($1::date, $2::date, 'closing', $3, $4, NOW())
           RETURNING *`,
          [periodStart, periodEnd, closeReason, userId]
        )
    const closure = closureResult.rows[0]

    const closeReference = `PAYROLL-CLOSE-${periodStart.slice(0, 7)}-${String(closure.id).slice(0, 8)}`
    const payableTransactions = await client.query(
      `SELECT id
       FROM commission_transactions
       WHERE commission_month=$1::date
         AND transaction_status IN ('approved','paid')
         AND (transaction_type IN ('earned','manual_add')
           OR (transaction_type='carry_forward' AND carry_forward_direction='credit'))
       ORDER BY salesperson_id, created_at, id`,
      [periodStart]
    )
    const closeSettlementIds: string[] = []
    let closeSettlementTotal = 0
    const closeAttempt = new Date(closure.created_at).getTime()
    for (const payable of payableTransactions.rows) {
      const normalized = normalizeCommissionPaymentInput({
        paymentMethod: 'payroll',
        reference: closeReference,
        notes: `Automatically recorded when ${periodStart} was closed. ${closeReason}`,
        settledAt: periodEnd
      }, `commission-close:${closure.id}:${closeAttempt}:${payable.id}`)
      const settlement = await payCommissionWithClient(client, payable.id, userId, normalized, true, true)
      if (settlement?.payment && !settlement.idempotent) {
        closeSettlementIds.push(settlement.payment.id)
        closeSettlementTotal += toNumber(settlement.payment.paid_amount)
      }
    }

    const balancesResult = await client.query(
      `WITH ledger AS (
         SELECT ct.salesperson_id,
                (array_agg(ct.programme_id ORDER BY ct.qualified_at DESC, ct.created_at DESC))[1] AS programme_id,
                COALESCE(SUM(CASE
                  WHEN ct.transaction_type IN ('earned', 'manual_add')
                    AND ct.transaction_status IN ('approved', 'paid', 'reversed') THEN ct.amount
                  WHEN ct.transaction_type = 'carry_forward'
                    AND ct.carry_forward_direction = 'credit'
                    AND ct.transaction_status IN ('approved', 'paid', 'reversed') THEN ct.amount
                  ELSE 0 END), 0) AS approved_credits,
                COALESCE(SUM(CASE
                  WHEN ct.transaction_type = 'reversal' THEN ct.amount
                  WHEN ct.transaction_type = 'manual_deduct'
                    AND ct.transaction_status IN ('approved', 'paid') THEN ct.amount
                  WHEN ct.transaction_type = 'carry_forward'
                    AND ct.carry_forward_direction = 'deduction'
                    AND ct.transaction_status IN ('approved', 'paid') THEN ct.amount
                  ELSE 0 END), 0) AS approved_deductions
         FROM commission_transactions ct
         WHERE ct.commission_month = $1::date
         GROUP BY ct.salesperson_id
       ), payments AS (
         SELECT COALESCE(ct.salesperson_id, cp.salesperson_id) AS salesperson_id,
                COALESCE(SUM(cp.paid_amount), 0) AS paid_amount
         FROM commission_payments cp
         LEFT JOIN commission_transactions ct ON ct.id = cp.commission_transaction_id
         WHERE cp.status <> 'voided'
           AND (date_trunc('month', cp.period_start)::date = $1::date
             OR date_trunc('month', ct.commission_month)::date = $1::date)
         GROUP BY COALESCE(ct.salesperson_id, cp.salesperson_id)
       )
       SELECT COALESCE(ledger.salesperson_id, payments.salesperson_id) AS salesperson_id,
              COALESCE(
                ledger.programme_id,
                (SELECT id FROM commission_programmes ORDER BY effective_from DESC, created_at DESC LIMIT 1)
              ) AS programme_id,
              COALESCE(ledger.approved_credits, 0) AS approved_credits,
              COALESCE(ledger.approved_deductions, 0) AS approved_deductions,
              COALESCE(payments.paid_amount, 0) AS paid_amount,
              COALESCE(ledger.approved_credits, 0) - COALESCE(ledger.approved_deductions, 0) - COALESCE(payments.paid_amount, 0) AS closing_balance
       FROM ledger
       FULL OUTER JOIN payments ON payments.salesperson_id = ledger.salesperson_id
       ORDER BY COALESCE(ledger.salesperson_id, payments.salesperson_id)`,
      [periodStart]
    )

    const balances: CommissionPeriodClosureBalance[] = []
    for (const balanceRow of balancesResult.rows) {
      const closingBalance = amountToCents(balanceRow.closing_balance)
      const carryAmount = amountToCents(Math.abs(closingBalance))
      if (carryAmount >= 0.01 && !balanceRow.programme_id) {
        throw Object.assign(new Error(`Cannot close ${periodStart}: a legacy payment has no commission programme context`), { statusCode: 409 })
      }
      let sourceOffsetTransactionId: string | null = null
      let carryForwardTransactionId: string | null = null

      if (closingBalance < -0.004 && carryAmount >= 0.01) {
        // A negative balance cannot be paid. Preserve it as a recovery against
        // the attendant in the following open month.
        const sourceDirection = 'credit'
        const targetDirection = 'deduction'
        const sourceOffset = await client.query(
          `INSERT INTO commission_transactions
            (programme_id, salesperson_id, amount, transaction_type, carry_forward_direction,
             transaction_status, qualification_date, qualified_at, commission_month,
             reference_type, reference_id, reason, approved_by, approved_at, created_by, created_at)
           VALUES ($1, $2, $3, 'carry_forward', $4, 'approved', $5::date, $6::timestamp, $7::date,
                   'commission_period_closure', $8, $9, $10, NOW(), $10, NOW())
           RETURNING id`,
          [
            balanceRow.programme_id,
            balanceRow.salesperson_id,
            carryAmount,
            sourceDirection,
            periodEnd,
            `${periodEnd} 23:59:59.999`,
            periodStart,
            closure.id,
            `Period ${periodStart} recovery offset; recovery continues in ${nextPeriodStart}. ${closeReason}`,
            userId
          ]
        )
        sourceOffsetTransactionId = sourceOffset.rows[0].id

        const carryForward = await client.query(
          `INSERT INTO commission_transactions
            (programme_id, salesperson_id, amount, transaction_type, carry_forward_direction,
             transaction_status, qualification_date, qualified_at, commission_month,
             reference_type, reference_id, reason, approved_by, approved_at, created_by, created_at)
           VALUES ($1, $2, $3, 'carry_forward', $4, 'approved', $5::date, $6::timestamp, $7::date,
                   'commission_period_closure', $8, $9, $10, NOW(), $10, NOW())
           RETURNING id`,
          [
            balanceRow.programme_id,
            balanceRow.salesperson_id,
            carryAmount,
            targetDirection,
            nextPeriodStart,
            `${nextPeriodStart} 00:00:00.000`,
            nextPeriodStart,
            closure.id,
            `Recovery due from closed period ${periodStart}. ${closeReason}`,
            userId
          ]
        )
        carryForwardTransactionId = carryForward.rows[0].id
      }

      const insertedBalance = await client.query(
        `INSERT INTO commission_period_closure_balances
          (closure_id, salesperson_id, programme_id, approved_credits, approved_deductions,
           paid_amount, closing_balance, source_offset_transaction_id, carry_forward_transaction_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         RETURNING *`,
        [
          closure.id,
          balanceRow.salesperson_id,
          balanceRow.programme_id,
          balanceRow.approved_credits,
          balanceRow.approved_deductions,
          balanceRow.paid_amount,
          closingBalance,
          sourceOffsetTransactionId,
          carryForwardTransactionId
        ]
      )
      balances.push(periodClosureBalanceFromRow(insertedBalance.rows[0]))
    }

    const closedResult = await client.query(
      `UPDATE commission_period_closures
       SET status = 'closed', closed_at = NOW(), closed_by = $2
       WHERE id = $1
       RETURNING *`,
      [closure.id, userId]
    )
    const closed = closedResult.rows[0]
    await logAudit({
      client,
      userId,
      action: 'commission_period_closed',
      entityType: 'commission_period_closure',
      entityId: closed.id,
      newValues: {
        period_start: periodStart,
        period_end: periodEnd,
        reason: closeReason,
        offline_payroll_reference: closeReference,
        offline_payroll_settlement_total: amountToCents(closeSettlementTotal),
        offline_payroll_settlement_ids: closeSettlementIds,
        salesperson_balances: balances.map(balance => ({
          salesperson_id: balance.salespersonId,
          closing_balance: balance.closingBalance,
          source_offset_transaction_id: balance.sourceOffsetTransactionId,
          carry_forward_transaction_id: balance.carryForwardTransactionId
        }))
      }
    })

    return {
      id: closed.id,
      periodStart,
      periodEnd,
      status: closed.status,
      reason: closed.reason,
      closedBy: closed.closed_by || null,
      closedAt: closed.closed_at || null,
      createdAt: closed.created_at,
      totalUnpaid: amountToCents(balances.reduce((sum, balance) => sum + Math.max(0, balance.closingBalance), 0)),
      totalRecovery: amountToCents(balances.reduce((sum, balance) => sum + Math.max(0, -balance.closingBalance), 0)),
      balances
    }
  })
}

export async function reopenCommissionPeriod(period: string, reason: string, userId: string | null) {
  const { periodStart, nextPeriodStart } = normalizeCommissionPeriod(period)
  const reopenReason = String(reason || '').trim()
  if (!reopenReason) throw Object.assign(new Error('A reason is required to undo a period close'), { statusCode: 400 })

  return transaction(async client => {
    await lockCommissionPeriod(client, periodStart)
    await lockCommissionPeriod(client, nextPeriodStart)
    await client.query('LOCK TABLE commission_transactions, commission_payments IN SHARE ROW EXCLUSIVE MODE')
    const closureResult = await client.query(
      `SELECT * FROM commission_period_closures
       WHERE period_start=$1::date AND status='closed' FOR UPDATE`,
      [periodStart]
    )
    const closure = closureResult.rows[0]
    if (!closure) return null
    const nextClosed = await client.query(
      `SELECT id FROM commission_period_closures WHERE period_start=$1::date AND status='closed'`,
      [nextPeriodStart]
    )
    if (nextClosed.rows.length > 0) {
      throw Object.assign(new Error(`Cannot undo ${periodStart}: the following period ${nextPeriodStart} is already closed`), { statusCode: 409 })
    }
    const balancesResult = await client.query(
      `SELECT balance.*, salesperson.full_name AS salesperson_name
       FROM commission_period_closure_balances balance
       JOIN users salesperson ON salesperson.id=balance.salesperson_id
       WHERE balance.closure_id=$1 FOR UPDATE OF balance`,
      [closure.id]
    )
    const carryPayments = await client.query(
      `SELECT cp.id FROM commission_payments cp
       JOIN commission_transactions ct ON ct.id=cp.commission_transaction_id
       WHERE ct.reference_type='commission_period_closure' AND ct.reference_id=$1
         AND cp.status <> 'voided'
       LIMIT 1`,
      [closure.id]
    )
    if (carryPayments.rows.length > 0) {
      throw Object.assign(new Error('Cannot undo this close because a carried balance has already been settled. Void that settlement first.'), { statusCode: 409 })
    }
    const voidedCarryPayments = await client.query(
      `SELECT cp.id, cp.commission_transaction_id
       FROM commission_payments cp
       JOIN commission_transactions ct ON ct.id=cp.commission_transaction_id
       WHERE ct.reference_type='commission_period_closure' AND ct.reference_id=$1
         AND cp.status='voided'
       FOR UPDATE OF cp`,
      [closure.id]
    )
    const closePayments = await client.query(
      `SELECT cp.id, cp.commission_transaction_id
       FROM commission_payments cp
       WHERE cp.status <> 'voided'
         AND cp.idempotency_key LIKE $1
       FOR UPDATE`,
      [`commission-close:${closure.id}:%`]
    )

    // A period-level deduction can make another credit appear payable. Ensure
    // removing a carried credit would not leave the following month overpaid.
    const unsafeTarget = await client.query(
      `WITH ledger AS (
         SELECT ct.salesperson_id,
                COALESCE(SUM(CASE
                  WHEN ct.reference_id IS DISTINCT FROM $1
                   AND ((ct.transaction_type IN ('earned','manual_add') AND ct.transaction_status IN ('approved','paid','reversed'))
                     OR (ct.transaction_type='carry_forward' AND ct.carry_forward_direction='credit' AND ct.transaction_status IN ('approved','paid','reversed')))
                  THEN ct.amount ELSE 0 END),0) AS credits,
                COALESCE(SUM(CASE
                  WHEN ct.reference_id IS DISTINCT FROM $1
                   AND (ct.transaction_type='reversal'
                     OR (ct.transaction_type='manual_deduct' AND ct.transaction_status IN ('approved','paid'))
                     OR (ct.transaction_type='carry_forward' AND ct.carry_forward_direction='deduction' AND ct.transaction_status IN ('approved','paid')))
                  THEN ct.amount ELSE 0 END),0) AS deductions
         FROM commission_transactions ct
         WHERE ct.commission_month=$2::date
         GROUP BY ct.salesperson_id
       ), payments AS (
         SELECT cp.salesperson_id, COALESCE(SUM(cp.paid_amount),0) AS paid
         FROM commission_payments cp
         LEFT JOIN commission_transactions ct ON ct.id=cp.commission_transaction_id
         WHERE cp.status <> 'voided'
           AND (date_trunc('month', cp.period_start)::date=$2::date
             OR date_trunc('month', ct.commission_month)::date=$2::date)
         GROUP BY cp.salesperson_id
       )
       SELECT ledger.salesperson_id
       FROM ledger LEFT JOIN payments USING (salesperson_id)
       WHERE ledger.credits - ledger.deductions - COALESCE(payments.paid,0) < -0.004
       LIMIT 1`,
      [closure.id, nextPeriodStart]
    )
    if (unsafeTarget.rows.length > 0) {
      throw Object.assign(new Error('Cannot undo this close because later settlements rely on its carried credit. Void the affected settlement first.'), { statusCode: 409 })
    }

    await client.query(`SELECT set_config('dlight.commission_reopen_closure', $1, TRUE)`, [closure.id])
    await client.query(
      `UPDATE commission_period_closures
       SET status='reopened', reopened_by=$2, reopened_at=NOW(), reopen_reason=$3
       WHERE id=$1`,
      [closure.id, userId, reopenReason]
    )
    for (const payment of closePayments.rows) {
      await client.query(
        `UPDATE commission_payments
         SET status='voided', voided_by=$2, voided_at=NOW(), void_reason=$3
         WHERE id=$1`,
        [payment.id, userId, `Automatically voided when period close was undone. ${reopenReason}`]
      )
      const activePaid = await client.query(
        `SELECT COALESCE(SUM(paid_amount),0) AS paid
         FROM commission_payments
         WHERE commission_transaction_id=$1 AND status <> 'voided'`,
        [payment.commission_transaction_id]
      )
      const transactionRow = await client.query(
        `SELECT amount FROM commission_transactions WHERE id=$1`,
        [payment.commission_transaction_id]
      )
      await client.query(
        `UPDATE commission_transactions SET transaction_status=$2 WHERE id=$1`,
        [payment.commission_transaction_id,
         toNumber(activePaid.rows[0]?.paid) + 0.000001 >= toNumber(transactionRow.rows[0]?.amount) ? 'paid' : 'approved']
      )
    }
    // Closure balances retain foreign keys to the two recovery ledger rows.
    // Remove the summary rows first so PostgreSQL can safely delete those
    // generated transactions. A voided payment remains as audit evidence but
    // must be detached from its disposable generated row first; retain that
    // former link in the payment notes and the reopen audit entry.
    await client.query(`DELETE FROM commission_period_closure_balances WHERE closure_id=$1`, [closure.id])
    for (const payment of voidedCarryPayments.rows) {
      await client.query(
        `UPDATE commission_payments
         SET commission_transaction_id=NULL,
             notes=CASE WHEN notes IS NULL OR notes='' THEN $2 ELSE notes || E'\n' || $2 END
         WHERE id=$1`,
        [payment.id, `Detached from generated transaction ${payment.commission_transaction_id} when commission close ${closure.id} was undone.`]
      )
    }
    await client.query(
      `DELETE FROM commission_transactions
       WHERE transaction_type='carry_forward' AND reference_type='commission_period_closure' AND reference_id=$1`,
      [closure.id]
    )
    await logAudit({
      client, userId, action: 'commission_period_reopened', entityType: 'commission_period_closure', entityId: closure.id,
      oldValues: {
        status: 'closed', period_start: periodStart, closed_at: closure.closed_at,
        balances: balancesResult.rows.map((row: any) => ({ salesperson_id: row.salesperson_id, closing_balance: row.closing_balance }))
      },
      newValues: {
        status: 'reopened', reason: reopenReason,
        voided_close_settlement_ids: closePayments.rows.map((row: any) => row.id),
        detached_voided_carry_payments: voidedCarryPayments.rows
      }
    })
    return { id: closure.id, periodStart, status: 'reopened', reopenReason }
  })
}

/**
 * One-time/admin repair for earnings that qualified after month-end but before
 * their source month was closed under the former qualification-month policy.
 * The source closure must first be safely reopened. Existing payment records
 * stay linked, but their accounting period and effective date move to the
 * source month-end. Every affected id and former date is retained in audit.
 */
export async function reclassifyPreCloseOrderCommissions(
  period: string,
  reason: string,
  userId: string | null
) {
  const { periodStart, periodEnd, nextPeriodStart } = normalizeCommissionPeriod(period)
  const repairReason = String(reason || '').trim()
  if (!repairReason) throw Object.assign(new Error('A reason is required to repair commission periods'), { statusCode: 400 })

  return transaction(async client => {
    await lockCommissionPeriod(client, periodStart)
    await lockCommissionPeriod(client, nextPeriodStart)
    await client.query('LOCK TABLE commission_transactions, commission_payments IN SHARE ROW EXCLUSIVE MODE')
    const closureResult = await client.query(
      `SELECT id, status, closed_at
       FROM commission_period_closures
       WHERE period_start=$1::date
       FOR UPDATE`,
      [periodStart]
    )
    const closure = closureResult.rows[0]
    if (!closure || closure.status !== 'reopened' || !closure.closed_at) {
      throw Object.assign(new Error(`Commission period ${periodStart} must be safely reopened before reclassification`), { statusCode: 409 })
    }
    const affected = await client.query(
      `SELECT ct.id, ct.commission_month, ct.source_period, ct.amount
       FROM commission_transactions ct
       WHERE ct.transaction_type='earned'
         AND date_trunc('month', ct.policy_date)::date=$1::date
         AND ct.commission_month <> $1::date
         AND ct.created_at <= $2::timestamp
       ORDER BY ct.created_at, ct.id
       FOR UPDATE OF ct`,
      [periodStart, closure.closed_at]
    )
    const ids = affected.rows.map((row: any) => row.id)
    const affectedPayments = ids.length > 0
      ? await client.query(
          `SELECT id, commission_transaction_id, period_start, paid_at
           FROM commission_payments
           WHERE commission_transaction_id=ANY($1::uuid[]) AND status <> 'voided'
           FOR UPDATE`,
          [ids]
        )
      : { rows: [] }
    if (ids.length > 0) {
      await client.query(
        `UPDATE commission_transactions
         SET commission_month=$2::date, source_period=$2::date,
             reason=CASE WHEN reason IS NULL OR reason='' THEN $3 ELSE reason || E'\n' || $3 END
         WHERE id=ANY($1::uuid[])`,
        [ids, periodStart, `[Period corrected to source month] ${repairReason}`]
      )
      await client.query(
        `UPDATE commission_payments
         SET period_start=$2::date, period_end=$3::date, paid_at=$3::date + TIME '12:00:00',
             notes=CASE WHEN notes IS NULL OR notes='' THEN $4 ELSE notes || E'\n' || $4 END
         WHERE commission_transaction_id=ANY($1::uuid[]) AND status <> 'voided'`,
        [ids, periodStart, periodEnd, `Effective period corrected to ${periodStart}. ${repairReason}`]
      )
    }
    await logAudit({
      client, userId, action: 'commission_period_reclassified', entityType: 'commission_period_closure', entityId: closure.id,
      oldValues: { transactions: affected.rows, payments: affectedPayments.rows },
      newValues: { period_start: periodStart, effective_settlement_date: periodEnd, transaction_ids: ids, reason: repairReason }
    })
    return { periodStart, transactionCount: ids.length, totalAmount: amountToCents(affected.rows.reduce((sum: number, row: any) => sum + toNumber(row.amount), 0)), transactionIds: ids }
  })
}

export async function getCommissionPeriodClosures(limit = 24): Promise<CommissionPeriodClosure[]> {
  const safeLimit = Math.min(120, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 24))
  const result = await query(
    `SELECT pc.id, pc.period_start, pc.period_end, pc.status, pc.reason, pc.closed_by, pc.closed_at, pc.created_at,
            pc.reopened_by, pc.reopened_at, pc.reopen_reason,
            closer.full_name AS closed_by_name, reopener.full_name AS reopened_by_name,
            COALESCE(SUM(GREATEST(balance.closing_balance, 0)), 0) AS total_unpaid,
            COALESCE(SUM(GREATEST(-balance.closing_balance, 0)), 0) AS total_recovery
     FROM commission_period_closures pc
     LEFT JOIN users closer ON closer.id = pc.closed_by
     LEFT JOIN users reopener ON reopener.id = pc.reopened_by
     LEFT JOIN commission_period_closure_balances balance ON balance.closure_id = pc.id
     GROUP BY pc.id, closer.full_name, reopener.full_name
     ORDER BY pc.period_start DESC
     LIMIT $1`,
    [safeLimit]
  )
  const closureIds = result.rows.map(row => row.id)
  const balancesByClosure = new Map<string, CommissionPeriodClosureBalance[]>()
  if (closureIds.length > 0) {
    const balanceResult = await query(
      `SELECT balance.*, salesperson.full_name AS salesperson_name
       FROM commission_period_closure_balances balance
       JOIN users salesperson ON salesperson.id = balance.salesperson_id
       WHERE balance.closure_id = ANY($1::uuid[])
       ORDER BY balance.closure_id, salesperson.full_name ASC`,
      [closureIds]
    )
    for (const row of balanceResult.rows) {
      const existing = balancesByClosure.get(row.closure_id) || []
      existing.push(periodClosureBalanceFromRow(row))
      balancesByClosure.set(row.closure_id, existing)
    }
  }
  return result.rows.map(row => ({
    id: row.id,
    periodStart: String(row.period_start).slice(0, 10),
    periodEnd: String(row.period_end).slice(0, 10),
    status: row.status,
    reason: row.reason,
    closedBy: row.closed_by || null,
    closedByName: row.closed_by_name || null,
    closedAt: row.closed_at || null,
    reopenedBy: row.reopened_by || null,
    reopenedByName: row.reopened_by_name || null,
    reopenedAt: row.reopened_at || null,
    reopenReason: row.reopen_reason || null,
    createdAt: row.created_at,
    totalUnpaid: amountToCents(row.total_unpaid),
    totalRecovery: amountToCents(row.total_recovery),
    balances: balancesByClosure.get(row.id) || []
  }))
}

export interface RetroactiveEvaluationResult {
  mode: 'preview' | 'apply'
  totalOrdersScanned: number
  totalItemsEvaluated: number
  eligibleItems: number
  alreadyEarnedItems: number
  ineligibleItems: number
  commissionsEarned: number
  reversalsCreated: number
  issuesFound: number
  runId?: string
  totalCommissionAmount: number
  details: Array<AuthoritativeCommissionEvaluation & { created: boolean; transactionId?: string }>
  issues: Array<{
    type: 'invalid_earning' | 'missing_reversal' | 'rate_mismatch' | 'policy_date_mismatch' | 'qualification_date_mismatch' | 'period_mismatch' | 'duplicate_earning' | 'missing_order_evidence' | 'quantity_mismatch' | 'attribution_mismatch'
    severity: 'warning' | 'error'
    transactionId?: string
    orderId?: string | null
    orderItemId?: string | null
    message: string
  }>
}

function dateOnly(value: unknown): string {
  if (value instanceof Date) return nairobiDate(value)
  return String(value || '').slice(0, 10)
}

function moneyMatches(left: unknown, right: unknown): boolean {
  return Math.abs(toNumber(left) - toNumber(right)) < 0.005
}

function isReviewOnlyCommissionEvidenceGap(evaluation: AuthoritativeCommissionEvaluation): boolean {
  const reason = String(evaluation.reason || '').toLowerCase()
  return (evaluation.categorySnapshotRequired === true && evaluation.categorySnapshotVerified === false) ||
    reason.includes('historic product category snapshot') ||
    reason.includes('required payment, completion, or delivery evidence is missing') ||
    reason.includes('order or order item does not exist') ||
    reason.includes('no salesperson attribution')
}

interface DeterministicCommissionReversalEvidence {
  targetReversedQuantity: number
  reason: string
}

// This deliberately avoids product/category/rate lookups.  Historic category
// provenance can make it unsafe to create or re-price an earning, but it does
// not make a recorded earning safe to retain when the order has unambiguously
// been returned, cancelled, or fully refunded.  The reversal is calculated
// from the original ledger row, so its recorded quantity and rate remain the
// source of truth.
async function deterministicReversalEvidence(
  orderId: string,
  orderItemId: string,
  recordedEligibleQuantity: unknown,
  executor: DbExecutor
): Promise<DeterministicCommissionReversalEvidence | null> {
  const recordedQuantity = Math.max(0, toNumber(recordedEligibleQuantity))
  if (recordedQuantity <= 0) return null

  const result = await executor.query(
    `SELECT o.status, o.paid_amount, oi.quantity, oi.returned_quantity,
            COALESCE((
              SELECT SUM(refund.amount)
              FROM order_refunds refund
              WHERE refund.order_id = o.id
                AND refund.status IN ('pending', 'paid')
            ), 0) AS active_refund_amount
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id AND oi.id = $2
     WHERE o.id = $1`,
    [orderId, orderItemId]
  )
  const row = result.rows[0]
  if (!row) return null

  if (['returned', 'cancelled'].includes(row.status)) {
    return {
      targetReversedQuantity: recordedQuantity,
      reason: `Order is ${row.status}`
    }
  }
  const paidAmount = Math.max(0, toNumber(row.paid_amount))
  const activeRefundAmount = Math.max(0, toNumber(row.active_refund_amount))
  if (paidAmount > 0 && activeRefundAmount + 0.005 >= paidAmount) {
    return {
      targetReversedQuantity: recordedQuantity,
      reason: 'Order has an active or paid full refund'
    }
  }

  // returned_quantity is cumulative.  When legacy data has a smaller recorded
  // earning than the item quantity, a return alone cannot prove which units
  // were commissionable.  Reverse only the lower bound that cannot still be
  // represented by the remaining units.  Comparing that target with prior
  // reversals below makes repeated reconciliation runs idempotent.
  const itemQuantity = Math.max(0, toNumber(row.quantity))
  const returnedQuantity = Math.min(itemQuantity, Math.max(0, toNumber(row.returned_quantity)))
  const remainingQuantity = Math.max(0, itemQuantity - returnedQuantity)
  const targetReversedQuantity = Math.max(0, recordedQuantity - remainingQuantity)
  if (targetReversedQuantity <= 0) return null
  return {
    targetReversedQuantity,
    reason: `${targetReversedQuantity} item(s) have been returned`
  }
}

export async function evaluateOrdersForDateRange(
  dateFrom: string,
  dateTo: string,
  userId: string | null,
  apply = false,
  reason: string | null = null,
  salespersonId?: string | null
): Promise<RetroactiveEvaluationResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    throw Object.assign(new Error('Dates must use YYYY-MM-DD format'), { statusCode: 400 })
  }
  const from = new Date(`${dateFrom}T00:00:00Z`)
  const to = new Date(`${dateTo}T00:00:00Z`)
  const days = Math.floor((to.getTime() - from.getTime()) / 86400000)
  if (Number.isNaN(days) || days < 0 || days > 366) {
    throw Object.assign(new Error('Date range must be between 0 and 366 days'), { statusCode: 400 })
  }
  if (apply && !String(reason || '').trim()) {
    throw Object.assign(new Error('A reason is required before applying retroactive commission'), { statusCode: 400 })
  }

  const evaluate = async (client: DbExecutor, runId: string | null): Promise<RetroactiveEvaluationResult> => {
    // Retroactive ranges are sale-date ranges. Completion only unlocks the
    // earning and determines its accounting month; it never changes the policy
    // or rate that applied when the sale was made.
    const orderResult = await client.query(
      `SELECT o.id, oi.id AS order_item_id
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.status IN ('delivered', 'collected_paid')
         AND o.payment_status = 'paid'
         ${salespersonId ? 'AND o.created_by = $3' : ''}
         AND o.sale_date BETWEEN $1::date AND $2::date
       ORDER BY o.id, oi.id`,
      salespersonId ? [dateFrom, dateTo, salespersonId] : [dateFrom, dateTo]
    )

    const details: RetroactiveEvaluationResult['details'] = []
    const issues: RetroactiveEvaluationResult['issues'] = []
    const processedOrders = new Set<string>()
    let totalCommissionAmount = 0
    let commissionsEarned = 0
    let reversalsCreated = 0
    let eligibleItems = 0
    let alreadyEarnedItems = 0
    let totalItemsEvaluated = 0

    for (const row of orderResult.rows) {
      try {
        const preview = await evaluateOrderItemFromRecords(row.id, row.order_item_id, client)
        totalItemsEvaluated += 1
        processedOrders.add(row.id)
        if (preview.alreadyEarned) alreadyEarnedItems += 1
        if (isReviewOnlyCommissionEvidenceGap(preview)) {
          issues.push({
            type: 'missing_order_evidence',
            severity: 'error',
            orderId: row.id,
            orderItemId: row.order_item_id,
            message: preview.reason || 'Commission evidence is incomplete and requires manual review.'
          })
        }
        if (preview.eligible) {
          eligibleItems += 1
          totalCommissionAmount += preview.amount || 0
        }

        if (apply && preview.eligible) {
          const applied = await evaluateAndEarnOrderItem(
            row.id,
            row.order_item_id,
            userId,
            client,
            runId ? 'commission_reconciliation_run' : null,
            runId
          )
          if (applied.earned) {
            commissionsEarned += 1
            details.push({ ...applied.evaluation, created: true, transactionId: applied.earned.transactionId })
            continue
          }
        }
        details.push({ ...preview, created: false })
      } catch (error) {
        if (apply) throw error
        details.push({
          eligible: false,
          orderId: row.id,
          orderItemId: row.order_item_id,
          reason: `Evaluation error: ${(error as Error).message}`,
          created: false
        })
        issues.push({ type: 'missing_order_evidence', severity: 'error', orderId: row.id, orderItemId: row.order_item_id, message: `Unable to evaluate item: ${(error as Error).message}` })
      }
    }

    // Reconcile the selected ledger period as well as looking for missing
    // earnings. A current return, refund, rate change, or wrong period must be
    // surfaced even if it can no longer appear in the completed-orders scan.
    const candidateOrderIds = [...new Set(orderResult.rows.map((row: any) => row.id))]
    const existingResult = await client.query(
      `SELECT id, order_id, order_item_id, salesperson_id, programme_id,
              eligible_quantity, rate_per_item, amount, policy_date, qualification_date, commission_month,
              source_period, created_at
       FROM commission_transactions ct
       WHERE ct.transaction_type = 'earned'
         AND (
           EXISTS (
             SELECT 1 FROM orders source_order
             WHERE source_order.id = ct.order_id
               AND source_order.sale_date BETWEEN $1::date AND $2::date
           )
           OR ct.order_id = ANY($3::uuid[])
         )
       ORDER BY ct.created_at ASC, ct.id ASC`,
      [dateFrom, dateTo, candidateOrderIds]
    )
    for (const earned of existingResult.rows) {
      if (!earned.order_id || !earned.order_item_id) {
        issues.push({ type: 'missing_order_evidence', severity: 'error', transactionId: earned.id, orderId: earned.order_id, orderItemId: earned.order_item_id, message: 'Earned transaction is missing its order or item reference and needs manual review.' })
        continue
      }
      let expected = await evaluateOrderItemFromRecords(earned.order_id, earned.order_item_id, client, { ignoreExistingEarned: true })
      // Serialise all apply-mode reconciliation decisions for this earning.
      // This prevents concurrent runs from observing the same shortfall before
      // either records its counter-entry.
      if (apply) {
        const locked = await client.query(
          `SELECT id FROM commission_transactions
           WHERE id = $1 AND transaction_type = 'earned'
           FOR UPDATE`,
          [earned.id]
        )
        if (locked.rows.length === 0) continue
        // Re-evaluate after the lock so the correction follows the current
        // authoritative order state, not a concurrent pre-lock observation.
        expected = await evaluateOrderItemFromRecords(
          earned.order_id,
          earned.order_item_id,
          client,
          { ignoreExistingEarned: true }
        )
      }
      const reviewOnly = isReviewOnlyCommissionEvidenceGap(expected)
      if (reviewOnly) {
        const reversalEvidence = await deterministicReversalEvidence(
          earned.order_id,
          earned.order_item_id,
          earned.eligible_quantity,
          client
        )
        if (reversalEvidence) {
          const reversed = await client.query(
            `SELECT COALESCE(SUM(eligible_quantity), 0) AS reversed_quantity
             FROM commission_transactions
             WHERE original_transaction_id = $1 AND transaction_type = 'reversal'`,
            [earned.id]
          )
          const reversalShortfall = Math.max(
            0,
            reversalEvidence.targetReversedQuantity - toNumber(reversed.rows[0]?.reversed_quantity)
          )
          if (reversalShortfall > 0) {
            issues.push({
              type: 'missing_reversal',
              severity: 'error',
              transactionId: earned.id,
              orderId: earned.order_id,
              orderItemId: earned.order_item_id,
              message: `${reversalShortfall} item(s) still require reversal: ${reversalEvidence.reason}.`
            })
            if (apply) {
              const reversal = await reverseCommission(
                earned.id,
                earned.order_id,
                earned.order_item_id,
                reversalShortfall,
                `Retroactive reconciliation: ${String(reason).trim()} (${reversalEvidence.reason})`,
                userId,
                client,
                runId ? 'commission_reconciliation_run' : null,
                runId
              )
              if (reversal) reversalsCreated += 1
            }
          }
          // The recorded earning/rate is now reconciled as far as certain return
          // evidence permits. Do not use an unverifiable category snapshot to
          // make any additional earning, rate, or eligibility call.
          continue
        }
        issues.push({
          type: 'missing_order_evidence',
          severity: 'error',
          transactionId: earned.id,
          orderId: earned.order_id,
          orderItemId: earned.order_item_id,
          message: `${expected.reason || 'Historic commission evidence is incomplete.'} The existing earning is preserved; use a reviewed correction if needed.`
        })
        continue
      }
      if (!expected.eligible) {
        const reversed = await client.query(
          `SELECT COALESCE(SUM(eligible_quantity), 0) AS reversed_quantity
           FROM commission_transactions
           WHERE original_transaction_id = $1 AND transaction_type = 'reversal'`,
          [earned.id]
        )
        const reversalShortfall = Math.max(0, toNumber(earned.eligible_quantity) - toNumber(reversed.rows[0]?.reversed_quantity))
        const issueType = reversalShortfall > 0 ? 'missing_reversal' : 'invalid_earning'
        const message = reversalShortfall > 0
          ? `Earned commission is no longer valid (${expected.reason || 'qualification failed'}); ${reversalShortfall} item(s) still require reversal.`
          : `Earned commission is no longer valid (${expected.reason || 'qualification failed'}) and has a matching reversal.`
        issues.push({ type: issueType, severity: reversalShortfall > 0 ? 'error' : 'warning', transactionId: earned.id, orderId: earned.order_id, orderItemId: earned.order_item_id, message })
        if (apply && reversalShortfall > 0) {
          const reversal = await reverseCommission(
            earned.id,
            earned.order_id,
            earned.order_item_id,
            reversalShortfall,
            `Retroactive reconciliation: ${String(reason).trim()}`,
            userId,
            client,
            runId ? 'commission_reconciliation_run' : null,
            runId
          )
          if (reversal) reversalsCreated += 1
        }
        continue
      }

      if (expected.salespersonId && earned.salesperson_id !== expected.salespersonId) {
        issues.push({
          type: 'attribution_mismatch',
          severity: 'error',
          transactionId: earned.id,
          orderId: earned.order_id,
          orderItemId: earned.order_item_id,
          message: 'Recorded salesperson attribution differs from the authoritative order attribution. Manual reviewed correction is required.'
        })
        continue
      }
      if (expected.programmeId && earned.programme_id !== expected.programmeId) {
        issues.push({
          type: 'attribution_mismatch',
          severity: 'error',
          transactionId: earned.id,
          orderId: earned.order_id,
          orderItemId: earned.order_item_id,
          message: 'Recorded programme differs from the programme in force at qualification. Manual reviewed correction is required.'
        })
        continue
      }

      const recordedQuantity = toNumber(earned.eligible_quantity)
      const expectedQuantity = toNumber(expected.quantity)
      if (expectedQuantity < recordedQuantity) {
        const reversed = await client.query(
          `SELECT COALESCE(SUM(eligible_quantity), 0) AS reversed_quantity
           FROM commission_transactions
           WHERE original_transaction_id = $1 AND transaction_type = 'reversal'`,
          [earned.id]
        )
        const requiredReversal = recordedQuantity - expectedQuantity
        const reversalShortfall = Math.max(0, requiredReversal - toNumber(reversed.rows[0]?.reversed_quantity))
        if (reversalShortfall > 0) {
          issues.push({
            type: 'missing_reversal',
            severity: 'error',
            transactionId: earned.id,
            orderId: earned.order_id,
            orderItemId: earned.order_item_id,
            message: `${reversalShortfall} returned item(s) still require a commission reversal.`
          })
          if (apply) {
            const reversal = await reverseCommission(
              earned.id,
              earned.order_id,
              earned.order_item_id,
              reversalShortfall,
              `Retroactive reconciliation: ${String(reason).trim()}`,
              userId,
              client,
              runId ? 'commission_reconciliation_run' : null,
              runId
            )
            if (reversal) reversalsCreated += 1
          }
        }
      } else if (expectedQuantity > recordedQuantity) {
        issues.push({
          type: 'quantity_mismatch',
          severity: 'error',
          transactionId: earned.id,
          orderId: earned.order_id,
          orderItemId: earned.order_item_id,
          message: `Recorded eligible quantity ${recordedQuantity} is below authoritative quantity ${expectedQuantity}. Manual reviewed correction is required.`
        })
      } else if (!moneyMatches(earned.rate_per_item, expected.rate) || !moneyMatches(earned.amount, expected.amount)) {
        issues.push({ type: 'rate_mismatch', severity: 'error', transactionId: earned.id, orderId: earned.order_id, orderItemId: earned.order_item_id, message: `Recorded amount ${toNumber(earned.amount)} at rate ${toNumber(earned.rate_per_item)} does not match the authoritative amount ${toNumber(expected.amount)} at rate ${toNumber(expected.rate)}. Manual reviewed correction is required.` })
      }
      if (expected.saleDate && dateOnly(earned.policy_date) !== expected.saleDate) {
        issues.push({ type: 'policy_date_mismatch', severity: 'error', transactionId: earned.id, orderId: earned.order_id, orderItemId: earned.order_item_id, message: `Recorded policy date ${dateOnly(earned.policy_date)} differs from order sale date ${expected.saleDate}. Manual reviewed correction is required.` })
      }
      const expectedDate = expected.qualificationDate || ''
      if (expectedDate && dateOnly(earned.qualification_date) !== expectedDate) {
        issues.push({ type: 'qualification_date_mismatch', severity: 'error', transactionId: earned.id, orderId: earned.order_id, orderItemId: earned.order_item_id, message: `Recorded qualification date ${dateOnly(earned.qualification_date)} differs from authoritative date ${expectedDate}. Manual reviewed correction is required.` })
      }
      const expectedSourceMonth = expected.saleDate ? `${expected.saleDate.slice(0, 7)}-01` : ''
      const expectedQualificationMonth = expectedDate ? `${expectedDate.slice(0, 7)}-01` : ''
      let expectedMonth = expectedSourceMonth
      if (expectedSourceMonth) {
        const sourceClosure = await client.query(
          `SELECT closed_at FROM commission_period_closures
           WHERE period_start=$1::date AND status='closed'`,
          [expectedSourceMonth]
        )
        if (sourceClosure.rows[0]?.closed_at && new Date(earned.created_at) > new Date(sourceClosure.rows[0].closed_at)) {
          expectedMonth = expectedQualificationMonth
        }
      }
      if (expectedMonth && dateOnly(earned.commission_month) !== expectedMonth) {
        issues.push({ type: 'period_mismatch', severity: 'error', transactionId: earned.id, orderId: earned.order_id, orderItemId: earned.order_item_id, message: `Recorded commission month ${dateOnly(earned.commission_month)} differs from the authoritative month ${expectedMonth}. Manual reviewed correction is required.` })
      }
    }

    const duplicateResult = await client.query(
      `SELECT order_item_id, COUNT(*)::int AS count
       FROM commission_transactions
       WHERE transaction_type = 'earned' AND transaction_status <> 'reversed' AND order_item_id IS NOT NULL
       GROUP BY order_item_id
       HAVING COUNT(*) > 1`
    )
    for (const duplicate of duplicateResult.rows) {
      issues.push({ type: 'duplicate_earning', severity: 'error', orderItemId: duplicate.order_item_id, message: `Order item has ${duplicate.count} earned commission records and requires manual ledger review.` })
    }

    return {
      mode: apply ? 'apply' : 'preview',
      totalOrdersScanned: processedOrders.size,
      totalItemsEvaluated,
      eligibleItems,
      alreadyEarnedItems,
      ineligibleItems: Math.max(0, totalItemsEvaluated - eligibleItems - alreadyEarnedItems),
      commissionsEarned,
      reversalsCreated,
      issuesFound: issues.length,
      totalCommissionAmount,
      details,
      issues,
      ...(runId ? { runId } : {})
    }
  }

  const auditResult = async (result: RetroactiveEvaluationResult, client?: DbExecutor) => {
    await logAudit({
      client,
      userId,
      action: 'commission_retroactive_evaluation',
      entityType: 'commission_reconciliation_run',
      entityId: result.runId || null,
      newValues: {
        date_from: dateFrom,
        date_to: dateTo,
        mode: result.mode,
        reason: reason || null,
        total_orders_scanned: result.totalOrdersScanned,
        total_items_evaluated: result.totalItemsEvaluated,
        eligible_items: result.eligibleItems,
        already_earned_items: result.alreadyEarnedItems,
        commissions_earned: result.commissionsEarned,
        reversals_created: result.reversalsCreated,
        issues_found: result.issuesFound,
        total_amount: result.totalCommissionAmount
      }
    })
  }

  const result = apply
    ? await transaction(async client => {
        const run = await client.query(
          `INSERT INTO commission_reconciliation_runs (date_from, date_to, mode, reason, status, created_by)
           VALUES ($1::date, $2::date, 'apply', $3, 'running', $4)
           RETURNING id`,
          [dateFrom, dateTo, String(reason).trim(), userId]
        )
        const evaluated = await evaluate(client, run.rows[0].id)
        await client.query(
          `UPDATE commission_reconciliation_runs
           SET status = 'completed', total_items_evaluated = $2, commissions_earned = $3,
               reversals_created = $4, issues_found = $5, completed_at = NOW()
           WHERE id = $1`,
          [run.rows[0].id, evaluated.totalItemsEvaluated, evaluated.commissionsEarned, evaluated.reversalsCreated, evaluated.issuesFound]
        )
        await auditResult(evaluated, client)
        return evaluated
      })
    : await evaluate(defaultExecutor, null)

  if (!apply) await auditResult(result)
  return result
}
