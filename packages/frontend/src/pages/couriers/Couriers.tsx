import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { useState } from 'react'
import { Plus, Search, Truck, Edit, Trash2 } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { useAuthStore } from '../../stores/authStore'

interface Courier {
  id: string
  name: string
  tracking_prefix?: string
  is_active?: boolean
}

interface CourierFormData {
  name: string
  tracking_prefix: string
}

export function Couriers() {
  const { hasPermission } = useAuthStore()
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editingCourier, setEditingCourier] = useState<Courier | null>(null)
  const queryClient = useQueryClient()
  const { register, handleSubmit, reset, formState: { errors } } = useForm<CourierFormData>()

  const { data: couriers = [], isLoading, error } = useQuery<Courier[]>({
    queryKey: ['couriers', search],
    queryFn: async () => (await axios.get(`/api/couriers?search=${search}`)).data
  })

  const saveCourier = useMutation({
    mutationFn: async (data: CourierFormData) => {
      if (editingCourier) {
        return (await axios.put(`/api/couriers/${editingCourier.id}`, { ...data, is_active: true })).data
      }
      return (await axios.post('/api/couriers', data)).data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['couriers'] })
      setShowForm(false)
      setEditingCourier(null)
      reset()
    }
  })

  const deleteCourier = useMutation({
    mutationFn: async (id: string) => axios.delete(`/api/couriers/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['couriers'] })
  })

  const editCourier = (courier: Courier) => {
    setEditingCourier(courier)
    reset({ name: courier.name, tracking_prefix: courier.tracking_prefix || '' })
    setShowForm(true)
  }

  if (error) {
    return <div className="p-6 text-destructive">Failed to load couriers</div>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Couriers</h1>
          <p className="text-muted-foreground">Manage Speedaf and other courier companies</p>
        </div>
        {hasPermission('couriers.manage') && <button
          onClick={() => { setShowForm(true); setEditingCourier(null); reset({ name: '', tracking_prefix: '' }) }}
          className="flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          Add Courier
        </button>}
      </div>

      {showForm && (
        <div className="border rounded-lg p-6 bg-card">
          <h2 className="font-semibold mb-4">{editingCourier ? 'Edit Courier' : 'Add Courier'}</h2>
          <form onSubmit={handleSubmit(data => saveCourier.mutate(data))} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Courier Name</label>
              <input {...register('name', { required: 'Courier name is required' })} className="w-full px-3 py-2 border rounded-lg placeholder:text-slate-500" placeholder="Example: Speedaf" />
              {errors.name && <span className="text-xs text-destructive">{errors.name.message}</span>}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Tracking Prefix</label>
              <input {...register('tracking_prefix')} className="w-full px-3 py-2 border rounded-lg placeholder:text-slate-500" placeholder="Example: SPD" />
            </div>
            <div className="md:col-span-2 flex gap-2">
              <button type="submit" disabled={saveCourier.isPending} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-50">
                {editingCourier ? 'Update Courier' : 'Create Courier'}
              </button>
              <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 border rounded-lg">Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input value={search} onChange={event => setSearch(event.target.value)} className="w-full pl-10 pr-4 py-2 border rounded-lg placeholder:text-slate-500" placeholder="Search couriers..." />
      </div>

      {isLoading ? (
        <div className="space-y-2">{[...Array(4)].map((_, index) => <div key={index} className="h-16 bg-muted rounded-lg animate-pulse" />)}</div>
      ) : couriers.length === 0 ? (
        <div className="text-center py-16">
          <Truck className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium">No couriers found</h3>
          <p className="text-muted-foreground mt-1">Add Speedaf or another courier to use courier delivery in orders</p>
        </div>
      ) : (
        <div className="mobile-scroll-table border rounded-lg overflow-x-auto">
          <table className="w-full">
            <thead className="bg-muted">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-left px-4 py-3 font-medium">Tracking Prefix</th>
                <th className="text-right px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {couriers.map(courier => (
                <tr key={courier.id} className="border-t hover:bg-muted/50">
                  <td className="px-4 py-3 font-medium">{courier.name}</td>
                  <td className="px-4 py-3 text-sm">{courier.tracking_prefix || '-'}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => editCourier(courier)} className="p-1.5 text-muted-foreground hover:text-primary rounded"><Edit className="h-4 w-4" /></button>
                    <button onClick={() => deleteCourier.mutate(courier.id)} className="p-1.5 text-muted-foreground hover:text-destructive rounded"><Trash2 className="h-4 w-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
