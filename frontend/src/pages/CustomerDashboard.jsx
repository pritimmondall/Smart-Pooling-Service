import React from 'react';
import { ArrowRight, CalendarDays } from 'lucide-react';
import { Link } from 'react-router-dom';
import DashboardBooking from '../components/common/DashboardBooking.jsx';
import './CustomerDashboard.css';

export default function CustomerDashboard() {
  return <div className="pool-home">
    <header className="visit-heading"><h1>Your visits</h1></header>
    <DashboardBooking />
    <section className="visit-request">
      <CalendarDays size={28} aria-hidden="true"/>
      <div><h2>Book a home visit</h2><p>Choose your service, location and time. We’ll match nearby visits and assign a technician.</p></div>
      <Link to="/create-booking" className="pool-primary">Book a visit <ArrowRight size={16}/></Link>
    </section>
  </div>;
}
