import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { useState } from 'react'
import { Plus, Search, Edit, Eye, Trash2, Shield, X } from 'lucide-react'
import { useForm } from 'react-hook-form'

interface User {
  id: string
  email: string
  full_name: string
  role: string
  is_active: boolean
  created_at: string
  permissions: string[]
}

interface Permission {
  id: string
  description: string
  module: string
  action: string
}

interface UserFormData {
  email: string
  full_name: string
  role: string
  password: string
  is_active: boolean
}

export function Users() {
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editingUser, setEditingUser] = useState<User | null>(null)
  const [viewingUser, setViewingUser] = useState<User | null>(null)
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([])
  const [formError, setFormError] = useState('')
  const queryClient = useQueryClient()

  const attendantDefaults = [
    'dashboard.view', 'orders.view', 'orders.create', 'orders.status',
    'customers.view', 'customers.create', 'customers.edit', 'products.view', 'suppliers.view',
    'riders.view', 'couriers.view', 'deliveries.view', 'deliveries.manage',
    'cod.view', 'cod.remit', 'inventory.view', 'receipts.view'
  ]

  const { data: users = [], isLoading, error } = useQuery<User[]>({
    queryKey: ['users', search],
    queryFn: async () => {
      const response = await axios.get(`/api/users?search=${search}`)
      return response.data
    }
  })

  const { data: permissions = [] } = useQuery<Permission[]>({
    queryKey: ['permissions'],
    queryFn: async () => (await axios.get('/api/users/permissions')).data
  })

  const { register, handleSubmit, reset, watch, formState: { errors } } = useForm<UserFormData>({
    defaultValues: { role: 'attendant', is_active: true }
  })
  const selectedRole = watch('role')

  const createUser = useMutation({
    mutationFn: async (data: UserFormData & { permissions: string[] }) => {
      const response = await axios.post('/api/users', data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      setShowForm(false)
      reset()
    }
  })

  const updateUser = useMutation({
    mutationFn: async (data: UserFormData & { permissions: string[] }) => {
      const response = await axios.put(`/api/users/${editingUser?.id}`, data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      setEditingUser(null)
      setShowForm(false)
      reset()
    }
  })

  const deleteUser = useMutation({
    mutationFn: async (id: string) => {
      await axios.delete(`/api/users/${id}`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
    }
  })

  const handleFormSubmit = (data: UserFormData) => {
    setFormError('')
    const payload = { ...data, permissions: data.role === 'admin' ? [] : selectedPermissions }
    if (editingUser) {
      updateUser.mutate(payload, {
        onError: (mutationError: any) => setFormError(mutationError.response?.data?.error?.message || 'Failed to update user')
      })
    } else {
      createUser.mutate(payload, {
        onError: (mutationError: any) => setFormError(mutationError.response?.data?.error?.message || 'Failed to create user')
      })
    }
  }

  const handleEdit = (user: User) => {
    setEditingUser(user)
    setSelectedPermissions(user.role === 'admin' ? [] : user.permissions || [])
    setFormError('')
    reset({
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      password: '',
      is_active: user.is_active
    })
    setShowForm(true)
  }

  const openCreateForm = () => {
    setEditingUser(null)
    setSelectedPermissions(attendantDefaults)
    setFormError('')
    reset({ email: '', full_name: '', role: 'attendant', password: '', is_active: true })
    setShowForm(true)
  }

  const togglePermission = (permission: string) => {
    setSelectedPermissions(current =>
      current.includes(permission) ? current.filter(item => item !== permission) : [...current, permission]
    )
  }

  const groupedPermissions = permissions.reduce<Record<string, Permission[]>>((groups, permission) => {
    groups[permission.module] = [...(groups[permission.module] || []), permission]
    return groups
  }, {})

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-muted-foreground">Failed to load users</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Users & Permissions</h1>
          <p className="text-muted-foreground">Manage system users and roles</p>
        </div>
        <button 
          onClick={openCreateForm}
          className="flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Add User
        </button>
      </div>

      {showForm && (
        <div className="border rounded-lg p-6 bg-card">
          <h2 className="font-semibold mb-4">{editingUser ? 'Edit' : 'Add'} User</h2>
          <form onSubmit={handleSubmit(handleFormSubmit)} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {formError && <div className="md:col-span-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{formError}</div>}
            <div>
              <label className="block text-sm font-medium mb-1">Email *</label>
              <input
                type="email"
                {...register('email', { required: 'Email is required' })}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="user@example.com"
              />
              {errors.email && <span className="text-xs text-destructive">{errors.email.message}</span>}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Full Name *</label>
              <input
                {...register('full_name', { required: 'Name is required' })}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="John Doe"
              />
              {errors.full_name && <span className="text-xs text-destructive">{errors.full_name.message}</span>}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Role</label>
              <select
                {...register('role')}
                className="w-full px-3 py-2 border rounded-lg"
              >
                <option value="admin">Admin</option>
                <option value="manager">Manager</option>
                <option value="attendant">Attendant</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Password {editingUser ? '(leave blank to keep)' : '*'}</label>
              <input
                type="password"
                {...register('password', { required: !editingUser })}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="••••••••"
              />
              {errors.password && <span className="text-xs text-destructive">{errors.password.message}</span>}
            </div>
            <label className="md:col-span-2 inline-flex items-center gap-2 text-sm">
              <input type="checkbox" {...register('is_active')} className="h-4 w-4" />
              Active user
            </label>
            <div className="md:col-span-2 border-t pt-4">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-medium">Access Rights</h3>
                  <p className="text-sm text-muted-foreground">Choose exactly what this user can view or change.</p>
                </div>
                {selectedRole !== 'admin' && (
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setSelectedPermissions(attendantDefaults)} className="px-3 py-2 border rounded-lg text-sm">
                      Attendant defaults
                    </button>
                    <button type="button" onClick={() => setSelectedPermissions(permissions.map(permission => `${permission.module}.${permission.action}`))} className="px-3 py-2 border rounded-lg text-sm">
                      Select all
                    </button>
                  </div>
                )}
              </div>
              {selectedRole === 'admin' ? (
                <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">
                  Administrators always have full access. Individual rights cannot be removed.
                </div>
              ) : (
                <div className="divide-y rounded-lg border">
                  {Object.entries(groupedPermissions).map(([module, modulePermissions]) => (
                    <div key={module} className="grid gap-3 p-4 md:grid-cols-[150px_1fr]">
                      <div className="font-medium capitalize">{module}</div>
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {modulePermissions.map(permission => {
                          const key = `${permission.module}.${permission.action}`
                          return (
                            <label key={permission.id} className="flex items-start gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={selectedPermissions.includes(key)}
                                onChange={() => togglePermission(key)}
                                className="mt-0.5 h-4 w-4"
                              />
                              <span>
                                <span className="block font-medium capitalize">{permission.action.replace('_', ' ')}</span>
                                <span className="text-xs text-muted-foreground">{permission.description}</span>
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="md:col-span-2 flex gap-2">
              <button
                type="submit"
                disabled={createUser.isPending || updateUser.isPending}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-50"
              >
                {editingUser ? 'Update' : 'Create'} User
              </button>
              <button
                type="button"
                onClick={() => { setShowForm(false); setEditingUser(null); setFormError('') }}
                className="px-4 py-2 border rounded-lg"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search users..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-primary focus:outline-none"
        />
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-16 bg-muted rounded-lg animate-pulse" />
          ))}
        </div>
      ) : users.length === 0 ? (
      <div className="text-center py-16">
        <Shield className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
        <h3 className="text-lg font-medium">No users found</h3>
          <p className="text-muted-foreground mt-1">
            {search ? 'Try adjusting your search' : 'Add your first user'}
          </p>
        </div>
      ) : (
        <div className="mobile-scroll-table border rounded-lg overflow-x-auto">
          <table className="w-full">
            <thead className="bg-muted">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-left px-4 py-3 font-medium">Email</th>
                <th className="text-left px-4 py-3 font-medium">Role</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-right px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-t hover:bg-muted/50 transition-colors">
                  <td className="px-4 py-3 font-medium">{user.full_name}</td>
                  <td className="px-4 py-3 text-sm">{user.email}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-primary/10 text-primary">
                      <Shield className="h-3 w-3" />
                      {user.role}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${user.is_active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
                      {user.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setViewingUser(user)}
                        className="p-1.5 text-muted-foreground hover:text-primary rounded"
                        title="View user"
                      >
                        <Eye className="h-4 w-4" />
                      </button>
                      <button 
                        onClick={() => handleEdit(user)}
                        className="p-1.5 text-muted-foreground hover:text-primary rounded"
                      >
                        <Edit className="h-4 w-4" />
                      </button>
                      <button 
                        onClick={() => deleteUser.mutate(user.id)}
                        className="p-1.5 text-muted-foreground hover:text-destructive rounded"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {viewingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-lg bg-background shadow-xl">
            <div className="flex items-center justify-between border-b px-6 py-4">
              <div>
                <h2 className="text-lg font-semibold">{viewingUser.full_name}</h2>
                <p className="text-sm text-muted-foreground">User details</p>
              </div>
              <button type="button" onClick={() => setViewingUser(null)} className="rounded p-1.5 text-muted-foreground hover:text-foreground" title="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="grid grid-cols-1 gap-4 p-6 text-sm">
              <div><span className="text-muted-foreground">Email:</span> {viewingUser.email}</div>
              <div><span className="text-muted-foreground">Role:</span> {viewingUser.role}</div>
              <div><span className="text-muted-foreground">Status:</span> {viewingUser.is_active ? 'Active' : 'Inactive'}</div>
              <div><span className="text-muted-foreground">Created:</span> {viewingUser.created_at ? new Date(viewingUser.created_at).toLocaleDateString() : '-'}</div>
              <div>
                <span className="text-muted-foreground">Access:</span>{' '}
                {viewingUser.role === 'admin' ? 'Full access' : `${viewingUser.permissions?.length || 0} assigned rights`}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
