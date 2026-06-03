import React from 'react';
import type { Order, GarmentStatusFilter } from './App';

interface Props {
  orders: Order[];
  selectedStatus: GarmentStatusFilter;
}

const statusLabel: Record<string, string> = {
  received: 'Received',
  in_cleaning: 'In Cleaning',
  ready: 'Ready for Pickup',
  delivered: 'Delivered',
};

export const OrdersList: React.FC<Props> = ({ orders, selectedStatus }) => {
  if (orders.length === 0) {
    return <p>No active orders.</p>;
  }

  // Filter garments inside each order; exclude orders that have no matching garments
  const filteredOrders = orders
    .map((order) => ({
      ...order,
      garments:
        selectedStatus === 'all'
          ? order.garments
          : order.garments.filter((g) => g.status === selectedStatus),
    }))
    .filter((order) => order.garments.length > 0);

  if (filteredOrders.length === 0) {
    return (
      <p>
        No garments with status <strong>{statusLabel[selectedStatus] ?? selectedStatus}</strong>.
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {filteredOrders.map((order) => (
        <div
          key={order.id}
          style={{
            border: '1px solid #ccc',
            borderRadius: 4,
            padding: '0.75rem',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <strong>{order.id}</strong>
            <span>{order.customerName}</span>
          </div>
          <small>Created: {new Date(order.createdAt).toLocaleString()}</small>
          <ul>
            {order.garments.map((g) => (
              <li key={g.id}>
                {g.description} - <em>{statusLabel[g.status] ?? g.status}</em>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
};
