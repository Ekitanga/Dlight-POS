import { useForm } from 'react-hook-form'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, EyeOff, LockKeyhole, PackageCheck, ShieldCheck, TrendingUp } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { useAuthStore } from '../../stores/authStore'
import { ThemeToggle } from '../../components/ThemeToggle'
import { applyAppearance, AppearanceSettings } from '../../lib/appearance'

interface LoginForm {
  email: string
  password: string
}

export function Login() {
  const { register, handleSubmit, formState: { errors } } = useForm<LoginForm>()
  const { login } = useAuthStore()
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const { data: branding } = useQuery<{ company_name: string; logo_url?: string } & AppearanceSettings>({
    queryKey: ['branding'],
    queryFn: async () => (await axios.get('/api/auth/branding')).data
  })

  useEffect(() => {
    if (branding) applyAppearance(branding)
  }, [branding])

  const onSubmit = async (data: LoginForm) => {
    setError('')
    try {
      await login(data.email, data.password)
      navigate('/dashboard')
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Login failed')
    }
  }

  const companyName = branding?.company_name || 'Dlight Giftshop'
  const logoUrl = branding?.logo_url

  return (
    <div className="min-h-screen overflow-hidden bg-[linear-gradient(180deg,hsl(var(--background)),hsl(var(--muted)/0.5))] text-foreground">
      <div className="fixed right-4 top-4 z-20">
        <ThemeToggle />
      </div>

      <div className="grid min-h-screen lg:grid-cols-[1.05fr_0.95fr]">
        <section className="relative hidden overflow-hidden bg-[linear-gradient(145deg,hsl(222_18%_9%),hsl(220_14%_13%)_48%,hsl(38_30%_18%))] px-12 py-10 text-white lg:flex lg:flex-col">
          <div className="relative z-10 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-white/15 bg-black/35 shadow-lg">
              {logoUrl ? (
                <img src={logoUrl} alt="" className="h-10 w-10 rounded-lg object-contain" />
              ) : (
                <span className="text-lg font-bold text-[hsl(var(--accent))]">DG</span>
              )}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase text-white/55">{companyName}</p>
              <h1 className="text-2xl font-semibold">Enterprise retail manager</h1>
            </div>
          </div>

          <div className="relative z-10 mt-auto max-w-2xl pb-10">
            <h2 className="text-5xl font-semibold leading-tight tracking-normal">
              Daily sales, inventory, deliveries, and profit in one clean workspace.
            </h2>
            <p className="mt-5 max-w-xl text-base leading-7 text-white/70">
              Track orders from counter to delivery, monitor supplier obligations, and keep the day&apos;s numbers clear before closing.
            </p>

            <div className="mt-8 grid max-w-xl grid-cols-3 gap-3">
              <div className="rounded-lg border border-white/10 bg-white/10 p-4 backdrop-blur">
                <PackageCheck className="mb-3 h-5 w-5 text-[hsl(var(--accent))]" />
                <p className="text-sm font-semibold">Inventory</p>
                <p className="mt-1 text-xs text-white/55">Stock first and supplier fulfilled flows</p>
              </div>
              <div className="rounded-lg border border-white/10 bg-white/10 p-4 backdrop-blur">
                <TrendingUp className="mb-3 h-5 w-5 text-[hsl(var(--accent))]" />
                <p className="text-sm font-semibold">Profit</p>
                <p className="mt-1 text-xs text-white/55">Daily and month-to-date clarity</p>
              </div>
              <div className="rounded-lg border border-white/10 bg-white/10 p-4 backdrop-blur">
                <ShieldCheck className="mb-3 h-5 w-5 text-[hsl(var(--accent))]" />
                <p className="text-sm font-semibold">Controls</p>
                <p className="mt-1 text-xs text-white/55">Roles, audit logs, and approvals</p>
              </div>
            </div>
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-[linear-gradient(180deg,transparent,hsl(var(--primary)/0.16))]" />
        </section>

        <main className="flex min-h-screen items-center justify-center px-4 py-6 sm:px-6 lg:px-10">
          <div className="w-full max-w-[440px]">
            <div className="mb-5 rounded-2xl border bg-card/80 p-4 shadow-sm backdrop-blur sm:hidden">
              <div className="flex items-center gap-3">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border bg-background shadow-sm">
                  {logoUrl ? (
                    <img src={logoUrl} alt="" className="h-11 w-11 rounded-xl object-contain" />
                  ) : (
                    <span className="text-base font-bold text-primary">DG</span>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold uppercase text-primary">{companyName}</p>
                  <h1 className="text-xl font-semibold leading-tight">Retail operations</h1>
                  <p className="mt-1 text-xs text-muted-foreground">Orders, stock, deliveries, and profit.</p>
                </div>
              </div>
            </div>

            <div className="mb-6 hidden flex-col items-center text-center sm:flex lg:hidden">
              <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-2xl border bg-card shadow-sm">
                {logoUrl ? (
                  <img src={logoUrl} alt="" className="h-12 w-12 rounded-xl object-contain" />
                ) : (
                  <span className="text-base font-bold text-primary">DG</span>
                )}
              </div>
              <p className="text-xs font-semibold uppercase text-muted-foreground">{companyName}</p>
              <h1 className="text-2xl font-semibold">Retail manager</h1>
            </div>

            <div className="rounded-2xl border bg-card p-5 shadow-sm sm:p-8">
              <div className="mb-7">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <LockKeyhole className="h-6 w-6" />
                </div>
                <h2 className="text-2xl font-semibold">Welcome back</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Sign in to manage today&apos;s orders, stock, payables, and profit.
                </p>
              </div>

              <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                {error && (
                  <div className="rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
                    {error}
                  </div>
                )}

                <div>
                  <label htmlFor="login-email" className="mb-1.5 block text-sm font-medium">Email</label>
                  <input
                    id="login-email"
                    type="email"
                    autoComplete="email"
                    {...register('email', { required: 'Email is required' })}
                    className="w-full rounded-lg border bg-background px-3 py-3 text-base transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                    placeholder="you@example.com"
                  />
                  {errors.email && <span className="mt-1 block text-xs text-destructive">{errors.email.message}</span>}
                </div>

                <div>
                  <label htmlFor="login-password" className="mb-1.5 block text-sm font-medium">Password</label>
                  <div className="relative">
                    <input
                      id="login-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      {...register('password', { required: 'Password is required' })}
                      className="w-full rounded-lg border bg-background px-3 py-3 pr-12 text-base transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                      placeholder="Enter your password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((value) => !value)}
                      className="absolute inset-y-0 right-1 flex w-11 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                    </button>
                  </div>
                  {errors.password && <span className="mt-1 block text-xs text-destructive">{errors.password.message}</span>}
                </div>

                <button
                  type="submit"
                  className="mt-2 flex w-full items-center justify-center rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
                >
                  Sign in securely
                </button>
              </form>

              <div className="mt-6 rounded-xl border bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
                Use your assigned account only. All sensitive actions are recorded in the audit trail.
              </div>
            </div>

            <p className="mt-5 text-center text-xs text-muted-foreground">
              {companyName} ERP/POS
            </p>
          </div>
        </main>
      </div>
    </div>
  )
}
