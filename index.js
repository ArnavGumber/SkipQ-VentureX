const express = require('express');
const app = express();
const path = require('path');

const hbs = require('express-handlebars');
app.engine('handlebars', hbs.engine({ defaultLayout: 'admin-layout' }));
app.set('view engine', 'handlebars');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const { cert, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const serviceAccount = require('./pingme-skipq-firebase-adminsdk.json');
const firebaseApp = initializeApp({
    credential: cert(serviceAccount)
});
const db = getFirestore(firebaseApp);
const APPOINTMENT_SESSION_COOKIE = 'skipq_appointment_request';
const APPOINTMENT_SESSION_MAX_AGE = 24 * 60 * 60;

function setAppointmentSessionCookie(req, res, requestId) {
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie',
        `${APPOINTMENT_SESSION_COOKIE}=${encodeURIComponent(requestId)}; Max-Age=${APPOINTMENT_SESSION_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax${secure}`
    );
}

function clearAppointmentSessionCookie(req, res) {
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie',
        `${APPOINTMENT_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`
    );
}

function getAppointmentSessionId(req) {
    const cookie = (req.get('cookie') || '').split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${APPOINTMENT_SESSION_COOKIE}=`));
    if (!cookie) return null;
    return cookie.slice(APPOINTMENT_SESSION_COOKIE.length + 1);
}

async function getPatientsAhead(doctorId) {
    const snapshot = await db.collection('appointmentRequests')
        .where('doctorId', '==', doctorId)
        .get();
    return snapshot.docs.filter((document) =>
        ['Pending', 'Verified'].includes(document.data().status)
    ).length;
}

function countVerifiedPatientsAhead(requests, tokenNumber) {
    return requests.docs.filter((document) => {
        const request = document.data();
        return request.status === 'Verified' &&
            (!Number.isInteger(request.tokenNumber) || request.tokenNumber < tokenNumber);
    }).length;
}

function formatQueuePosition(position) {
    const lastTwoDigits = position % 100;
    const suffix = lastTwoDigits >= 11 && lastTwoDigits <= 13
        ? 'th'
        : ({ 1: 'st', 2: 'nd', 3: 'rd' }[position % 10] || 'th');
    return `${position}${suffix}`;
}

async function getVerifiedPatientsAhead(request) {
    if (!Number.isInteger(request.tokenNumber)) return null;
    const snapshot = await db.collection('appointmentRequests')
        .where('doctorId', '==', request.doctorId)
        .get();
    return countVerifiedPatientsAhead(snapshot, request.tokenNumber);
}

app.get('/', (req, res) => {
    res.render('main', {
        layout: 'main-layout.handlebars'
    })
})

app.get('/admin', (req, res) => {
    res.render('admin');
})

app.get('/api/doctors', async (req, res) => {
    try {
        const snapshot = await db.collection('doctors').orderBy('createdAt', 'desc').get();
        res.json(snapshot.docs.map((document) => ({
            ...document.data(),
            id: document.id
        })));
    } catch (error) {
        console.error('Failed to retrieve doctors from Firestore:', error);
        res.status(500).json({ error: 'Unable to retrieve doctors.' });
    }
});

app.post('/api/doctors', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body
        : {};
    const { name, specialty, phone, email, hours } = body;
    const doctor = {
        name: typeof name === 'string' ? name.trim() : '',
        specialty: typeof specialty === 'string' ? specialty.trim() : '',
        phone: typeof phone === 'string' ? phone.trim() : '',
        email: typeof email === 'string' ? email.trim() : '',
        hours: typeof hours === 'string' ? hours.trim() : ''
    };

    if (!doctor.name || !doctor.specialty || !doctor.phone || !doctor.hours) {
        return res.status(400).json({ error: 'Name, specialty, phone, and hours are required.' });
    }
    if (doctor.name.length > 100 || doctor.specialty.length > 100 ||
        doctor.phone.length > 30 || doctor.email.length > 254 || doctor.hours.length > 100) {
        return res.status(400).json({ error: 'One or more doctor fields exceed the allowed length.' });
    }
    if (doctor.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(doctor.email)) {
        return res.status(400).json({ error: 'Enter a valid email address.' });
    }

    try {
        const document = await db.collection('doctors').add({
            ...doctor,
            createdAt: new Date()
        });
        res.status(201).json({ id: document.id, ...doctor });
    } catch (error) {
        console.error('Failed to save doctor to Firestore:', error);
        res.status(500).json({ error: 'Unable to save doctor.' });
    }
});

app.get('/api/doctors/:id/patients-ahead', async (req, res) => {
    const { id } = req.params;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
        return res.status(400).json({ error: 'Invalid doctor ID.' });
    }

    try {
        const doctor = await db.collection('doctors').doc(id).get();
        if (!doctor.exists) {
            return res.status(404).json({ error: 'Doctor not found.' });
        }
        res.json({ patientsAhead: await getPatientsAhead(id) });
    } catch (error) {
        console.error('Failed to retrieve doctor queue from Firestore:', error);
        res.status(500).json({ error: 'Unable to retrieve the doctor queue.' });
    }
});

app.get('/api/appointment-requests', async (req, res) => {
    try {
        const snapshot = await db.collection('appointmentRequests').orderBy('createdAt', 'desc').get();
        res.json(snapshot.docs.map((document) => {
            const data = document.data();
            return {
                ...data,
                id: document.id,
                createdAt: data.createdAt?.toDate().toISOString()
            };
        }));
    } catch (error) {
        console.error('Failed to retrieve appointment requests from Firestore:', error);
        res.status(500).json({ error: 'Unable to retrieve appointment requests.' });
    }
});

app.get('/api/appointment-session', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const requestId = getAppointmentSessionId(req);
    if (!requestId || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) {
        clearAppointmentSessionCookie(req, res);
        return res.json({ appointmentRequest: null });
    }

    try {
        const snapshot = await db.collection('appointmentRequests').doc(requestId).get();
        if (!snapshot.exists) {
            clearAppointmentSessionCookie(req, res);
            return res.json({ appointmentRequest: null });
        }
        const request = snapshot.data();
        const appointmentRequest = {
            status: request.status,
            token: request.token || null,
            patientsAhead: request.status === 'Verified'
                ? await getVerifiedPatientsAhead(request)
                : null
        };
        res.json({ appointmentRequest });
    } catch (error) {
        console.error('Failed to retrieve appointment session from Firestore:', error);
        res.status(500).json({ error: 'Unable to retrieve appointment session.' });
    }
});

app.post('/api/appointment-requests', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body
        : {};
    const patientName = typeof body.patientName === 'string' ? body.patientName.trim() : '';
    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    const doctorId = typeof body.doctorId === 'string' ? body.doctorId.trim() : '';
    const age = body.age;

    if (!patientName || patientName.length > 100 ||
        !Number.isInteger(age) || age < 1 || age > 120 ||
        !/^[6-9]\d{9}$/.test(phone) ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(doctorId)) {
        return res.status(400).json({ error: 'Enter valid patient details and select a valid doctor.' });
    }

    try {
        const doctorSnapshot = await db.collection('doctors').doc(doctorId).get();
        if (!doctorSnapshot.exists) {
            return res.status(404).json({ error: 'The selected doctor was not found.' });
        }

        const doctor = doctorSnapshot.data();
        const patientsAhead = await getPatientsAhead(doctorId);
        const appointmentRequest = {
            patientName,
            age,
            phone,
            doctorId,
            doctorName: doctor.name,
            department: doctor.specialty,
            patientsAhead,
            status: 'Pending',
            createdAt: new Date()
        };
        const document = await db.collection('appointmentRequests').add(appointmentRequest);

        setAppointmentSessionCookie(req, res, document.id);
        res.status(201).json({
            ...appointmentRequest,
            id: document.id,
            createdAt: appointmentRequest.createdAt.toISOString()
        });
    } catch (error) {
        console.error('Failed to save appointment request to Firestore:', error);
        res.status(500).json({ error: 'Unable to save appointment request.' });
    }
});

app.post('/api/appointment-requests/:id/verify', async (req, res) => {
    const { id } = req.params;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
        return res.status(400).json({ error: 'Invalid appointment request ID.' });
    }

    try {
        const document = db.collection('appointmentRequests').doc(id);
        const tokenCounter = db.collection('counters').doc('appointmentTokens');
        const result = await db.runTransaction(async (transaction) => {
            const snapshot = await transaction.get(document);
            if (!snapshot.exists) return { error: 'not-found' };

            const request = snapshot.data();
            if (request.status !== 'Pending') return { error: 'not-pending' };

            const doctorSnapshot = await transaction.get(
                db.collection('doctors').doc(request.doctorId)
            );
            if (!doctorSnapshot.exists) return { error: 'doctor-not-found' };

            const counterSnapshot = await transaction.get(tokenCounter);
            let lastTokenNumber;
            if (counterSnapshot.exists &&
                Number.isInteger(counterSnapshot.data().lastTokenNumber)) {
                lastTokenNumber = counterSnapshot.data().lastTokenNumber;
            } else {
                const verifiedRequests = await transaction.get(
                    db.collection('appointmentRequests').where('status', '==', 'Verified')
                );
                lastTokenNumber = verifiedRequests.docs.reduce((max, verifiedRequest) =>
                    Math.max(max, Number.isInteger(verifiedRequest.data().tokenNumber)
                        ? verifiedRequest.data().tokenNumber
                        : 0), verifiedRequests.size);
            }

            const tokenNumber = lastTokenNumber + 1;
            const queue = await transaction.get(
                db.collection('appointmentRequests').where('doctorId', '==', request.doctorId)
            );
            const patientsAhead = countVerifiedPatientsAhead(queue, tokenNumber);
            const token = `T${String(tokenNumber).padStart(3, '0')}`;
            const verifiedAt = new Date();

            transaction.update(document, {
                status: 'Verified',
                verifiedAt,
                token,
                tokenNumber,
                patientsAhead,
                queueStatus: 'Waiting'
            });
            transaction.set(tokenCounter, { lastTokenNumber: tokenNumber }, { merge: true });

            return {
                id,
                status: 'Verified',
                token,
                tokenNumber,
                patientsAhead,
                verifiedAt,
                doctorName: doctorSnapshot.data().name,
                phone: request.phone
            };
        });

        if (result.error === 'not-found') {
            return res.status(404).json({ error: 'Appointment request not found.' });
        }
        if (result.error === 'doctor-not-found') {
            return res.status(404).json({ error: 'The doctor for this request was not found.' });
        }
        if (result.error === 'not-pending') {
            return res.status(409).json({ error: 'This appointment request has already been verified.' });
        }

        const { phone, doctorName, ...verification } = result;
        const queuePosition = result.patientsAhead + 1;
        const message = `Your appointment with ${doctorName} is scheduled. You are ${formatQueuePosition(queuePosition)} in the queue. Your token is ${result.token}.`;
        let smsSent = false;
        try {
            await sendSMS(phone, message);
            smsSent = true;
        } catch (error) {
            console.error('Appointment was verified, but its SMS notification failed:', error);
        }

        res.json({
            ...verification,
            verifiedAt: result.verifiedAt.toISOString(),
            smsSent
        });
    } catch (error) {
        console.error('Failed to verify appointment request in Firestore:', error);
        res.status(500).json({ error: 'Unable to verify appointment request.' });
    }
});

app.post('/api/appointment-requests/:id/queue-status', async (req, res) => {
    const { id } = req.params;
    const requestedQueueStatus = req.body?.queueStatus;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
        return res.status(400).json({ error: 'Invalid appointment request ID.' });
    }
    if (!['Waiting', 'Now Serving', 'Completed'].includes(requestedQueueStatus)) {
        return res.status(400).json({ error: 'Invalid queue status.' });
    }

    try {
        const document = db.collection('appointmentRequests').doc(id);
        const result = await db.runTransaction(async (transaction) => {
            const snapshot = await transaction.get(document);
            if (!snapshot.exists) return { error: 'not-found' };

            const request = snapshot.data();
            if (!request.token || !['Verified', 'Completed'].includes(request.status)) {
                return { error: 'not-verified' };
            }

            const currentQueueStatus = request.queueStatus ||
                (request.status === 'Completed' ? 'Completed' : 'Waiting');
            if (requestedQueueStatus === currentQueueStatus) {
                return {
                    id,
                    status: request.status,
                    queueStatus: currentQueueStatus,
                    queueUpdatedAt: request.queueUpdatedAt || null
                };
            }

            const validTransition =
                (currentQueueStatus === 'Waiting' && requestedQueueStatus === 'Now Serving') ||
                (currentQueueStatus === 'Now Serving' &&
                    ['Waiting', 'Completed'].includes(requestedQueueStatus));
            if (!validTransition) return { error: 'invalid-transition' };

            if (requestedQueueStatus === 'Now Serving') {
                const doctorQueue = await transaction.get(
                    db.collection('appointmentRequests')
                        .where('doctorId', '==', request.doctorId)
                );
                const anotherPatientIsBeingServed = doctorQueue.docs.some((queuedRequest) =>
                    queuedRequest.id !== id &&
                    queuedRequest.data().status === 'Verified' &&
                    queuedRequest.data().queueStatus === 'Now Serving'
                );
                if (anotherPatientIsBeingServed) return { error: 'doctor-busy' };
            }

            const queueUpdatedAt = new Date();
            const status = requestedQueueStatus === 'Completed' ? 'Completed' : 'Verified';
            transaction.update(document, {
                status,
                queueStatus: requestedQueueStatus,
                queueUpdatedAt
            });
            return { id, status, queueStatus: requestedQueueStatus, queueUpdatedAt };
        });

        if (result.error === 'not-found') {
            return res.status(404).json({ error: 'Appointment request not found.' });
        }
        if (result.error === 'not-verified') {
            return res.status(409).json({ error: 'Only verified appointments can be added to the live queue.' });
        }
        if (result.error === 'invalid-transition') {
            return res.status(409).json({ error: 'That queue status change is not allowed.' });
        }
        if (result.error === 'doctor-busy') {
            return res.status(409).json({ error: 'Complete the current appointment for this doctor before serving the next patient.' });
        }

        const queueUpdatedAt = typeof result.queueUpdatedAt?.toDate === 'function'
            ? result.queueUpdatedAt.toDate().toISOString()
            : result.queueUpdatedAt instanceof Date
                ? result.queueUpdatedAt.toISOString()
                : null;
        res.json({
            ...result,
            queueUpdatedAt
        });
    } catch (error) {
        console.error('Failed to update appointment queue status in Firestore:', error);
        res.status(500).json({ error: 'Unable to update the appointment queue.' });
    }
});

app.get('/about', (req, res) => {
    res.sendFile(__dirname + '/pages/landing-page.html');
})

app.get('/patients', (req, res) => {
    res.sendFile(__dirname + '/pages/patients.html');
})

async function sendSMS(phone, message) {
    const response = await fetch("https://www.traccar.org/sms/", {
        method: "POST",
        headers: {
            "Authorization": 'dCFhXWIHRkS_ODJ6vZcY7C:APA91bF-wNQAFtFm_A98v_eFClJiI5ped_OAspY6KV7mGPzU3NzmPxt23xPCM3z4ttkC3HW-fLLNIP-AhXhVDaQ6KOBmrajBYv_GT-RV4s_QeJILgnqMZPw',
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            to: phone,
            message: message
        })
    });

    if (!response.ok) {
        throw new Error(`HTTP Error: ${response.status}`);
    }

    return true;
}


app.listen(3000, () => {
    console.log('Server is live !');
})