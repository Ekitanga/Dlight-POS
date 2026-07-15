import { useForm } from 'react-hook-form'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../../stores/authStore'
import { ThemeToggle } from '../../components/ThemeToggle'

interface LoginForm {
  email: string
  password: string
}

export function Login() {
  const { register, handleSubmit, formState: { errors } } = useForm<LoginForm>()
  const { login } = useAuthStore()
  const navigate = useNavigate()
  const [error, setError] = useState('')

  const onSubmit = async (data: LoginForm) => {
    setError('')
    try {
      await login(data.email, data.password)
      navigate('/dashboard')
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Login failed')
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-primary">Dlight POS</h1>
          <p className="text-sm text-muted-foreground mt-2">Sign in to your account</p>
        </div>
        
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {error && (
            <div className="p-3 text-sm text-destructive bg-destructive/10 rounded-lg">
              {error}
            </div>
          )}
          
          <div>
            <label htmlFor="login-email" className="block text-sm font-medium mb-1.5">Email</label>
            <input
              id="login-email"
              type="email"
              {...register('email', { required: 'Email is required' })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-primary focus:outline-none"
              placeholder="you@example.com"
            />
            {errors.email && <span className="text-xs text-destructive mt-1">{errors.email.message}</span>}
          </div>
          
          <div>
            <label htmlFor="login-password" className="block text-sm font-medium mb-1.5">Password</label>
            <input
              id="login-password"
              type="password"
              {...register('password', { required: 'Password is required' })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-primary focus:outline-none"
              placeholder="Enter your password"
            />
            {errors.password && <span className="text-xs text-destructive mt-1">{errors.password.message}</span>}
          </div>
          
          <button
            type="submit"
            className="w-full py-2.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors font-medium"
          >
            Sign In
          </button>
        </form>
      </div>
    </div>
  )
}
