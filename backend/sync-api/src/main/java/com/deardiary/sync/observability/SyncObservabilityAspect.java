package com.deardiary.sync.observability;

import com.deardiary.sync.common.ApiException;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import java.util.concurrent.TimeUnit;
import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.springframework.stereotype.Component;

@Aspect
@Component
public class SyncObservabilityAspect {
    private final MeterRegistry meters;

    public SyncObservabilityAspect(MeterRegistry meters) {
        this.meters = meters;
    }

    @Around("execution(* com.deardiary.sync.operation.OperationInitiationService.initiate(..))")
    public Object operationInitiate(ProceedingJoinPoint joinPoint) throws Throwable {
        return observe(joinPoint, "sync_operation_initiate_total", "sync_operation_initiate_duration");
    }

    @Around("execution(* com.deardiary.sync.operation.OperationCommitService.commit(..))")
    public Object operationCommit(ProceedingJoinPoint joinPoint) throws Throwable {
        return observe(joinPoint, "sync_operation_commit_total", "sync_operation_commit_duration");
    }

    @Around("execution(* com.deardiary.sync.event.EventPullService.pull(..))")
    public Object eventPull(ProceedingJoinPoint joinPoint) throws Throwable {
        return observe(joinPoint, "sync_event_pull_total", "sync_event_pull_duration");
    }

    @Around("execution(* com.deardiary.sync.snapshot.SnapshotService.initiate(..))")
    public Object snapshotInitiate(ProceedingJoinPoint joinPoint) throws Throwable {
        return observe(joinPoint, "sync_snapshot_initiate_total", "sync_snapshot_initiate_duration");
    }

    @Around("execution(* com.deardiary.sync.snapshot.SnapshotService.register(..))")
    public Object snapshotRegister(ProceedingJoinPoint joinPoint) throws Throwable {
        return observe(joinPoint, "sync_snapshot_register_total", "sync_snapshot_register_duration");
    }

    @Around("execution(* com.deardiary.sync.snapshot.SnapshotService.latest(..))")
    public Object snapshotRestoreLookup(ProceedingJoinPoint joinPoint) throws Throwable {
        return observe(joinPoint, "sync_snapshot_lookup_total", "sync_snapshot_lookup_duration");
    }

    @Around("execution(* com.deardiary.sync.device.DeviceRegistrationService.register(..))")
    public Object deviceRegistration(ProceedingJoinPoint joinPoint) throws Throwable {
        return observe(joinPoint, "sync_device_registration_total", "sync_device_registration_duration");
    }

    @Around("execution(* com.deardiary.sync.objectstore.EncryptedObjectStore.*(..))")
    public Object objectStorage(ProceedingJoinPoint joinPoint) throws Throwable {
        return observe(joinPoint, "sync_object_storage_request_total", "sync_object_storage_request_duration");
    }

    @Around("execution(public * com.deardiary.sync.migration.MigrationService.*(..)) || "
        + "execution(public * com.deardiary.sync.pairing.PairingService.*(..)) || "
        + "execution(public * com.deardiary.sync.recovery.RecoveryService.*(..)) || "
        + "execution(public * com.deardiary.sync.rotation.RotationService.*(..))")
    public Object advancedWorkflow(ProceedingJoinPoint joinPoint) throws Throwable {
        var workflow = joinPoint.getSignature().getDeclaringType().getSimpleName().replace("Service", "").toLowerCase();
        var action = joinPoint.getSignature().getName();
        try {
            var result = joinPoint.proceed();
            meters.counter("sync_advanced_workflow_total", "workflow", workflow, "action", action, "outcome", "success").increment();
            return result;
        } catch (Throwable error) {
            meters.counter("sync_advanced_workflow_total", "workflow", workflow, "action", action, "outcome", "failure").increment();
            throw error;
        }
    }

    private Object observe(ProceedingJoinPoint joinPoint, String counter, String timer) throws Throwable {
        var started = System.nanoTime();
        var outcome = "success";
        try {
            var result = joinPoint.proceed();
            if (counter.equals("sync_operation_initiate_total")) {
                meters.counter("sync_object_upload_initiated_total").increment();
                if (result instanceof com.deardiary.sync.operation.InitiateOperationResponse initiated && initiated.existing()) {
                    meters.counter("sync_operation_duplicate_total").increment();
                }
            }
            if (counter.equals("sync_event_pull_total") && result instanceof com.deardiary.sync.event.PullEventsResponse page) {
                meters.summary("sync_event_batch_size").record(page.events().size());
            }
            return result;
        } catch (Throwable error) {
            outcome = "failure";
            if (error instanceof ApiException api) {
                if ("RECORD_VERSION_CONFLICT".equals(api.code())) meters.counter("sync_operation_conflict_total").increment();
                if (api.code().contains("HASH") || api.code().contains("OBJECT")) {
                    meters.counter("sync_object_validation_failure_total", "error_code", api.code()).increment();
                }
            }
            if (counter.equals("sync_object_storage_request_total")) {
                var status = error instanceof com.deardiary.sync.objectstore.ObjectStoreException storage
                    && storage.statusCode() != null ? storage.statusCode().toString() : "unknown";
                meters.counter("sync_object_storage_error_total", "status", status).increment();
            }
            throw error;
        } finally {
            meters.counter(counter, "outcome", outcome).increment();
            Timer.builder(timer).tag("outcome", outcome).register(meters)
                .record(System.nanoTime() - started, TimeUnit.NANOSECONDS);
        }
    }

    @Around("execution(* com.deardiary.sync.notification.SyncNotificationPublisher.publish(..))")
    public Object notificationPublish(ProceedingJoinPoint joinPoint) throws Throwable {
        try { return joinPoint.proceed(); }
        catch (Throwable error) { meters.counter("sync_notification_publish_failure_total").increment(); throw error; }
    }

    @Around("execution(* com.deardiary.sync..*Service.*(..))")
    public Object databaseTransaction(ProceedingJoinPoint joinPoint) throws Throwable {
        var started = System.nanoTime();
        try { return joinPoint.proceed(); }
        catch (org.springframework.dao.PessimisticLockingFailureException error) {
            meters.counter("sync_database_deadlock_total").increment();
            throw error;
        }
        finally { meters.timer("sync_database_transaction_duration").record(System.nanoTime() - started, TimeUnit.NANOSECONDS); }
    }
}
