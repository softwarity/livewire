package io.softwarity.livewire;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;
import jakarta.enterprise.inject.Any;
import jakarta.enterprise.inject.Instance;
import jakarta.inject.Inject;

import org.eclipse.microprofile.config.inject.ConfigProperty;
import org.jboss.logging.Logger;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import io.vertx.core.Vertx;
import io.vertx.ext.web.Router;
import io.vertx.ext.web.RoutingContext;

/**
 * The endpoint: every subscription of every client passes through it, at {@code livewire.path}
 * on the application's router — so under {@code quarkus.http.root-path} like any other route.
 *
 * <pre>
 * livewire.path=/live          # where the socket is opened (default /livewire)
 * livewire.coalesce=300ms      # how long a burst of changes gathers before a read
 * </pre>
 *
 * The sources are the beans annotated {@link LiveTopic}, a {@link Source} or a
 * {@link SourceWithContext}, the commands the {@link LiveCommand}
 * methods of the beans implementing {@link LiveCommands}, and a {@link LivewireAuthorizer} bean,
 * if there is one, decides who may open the socket. {@link #notify} tells every client
 * something happened.
 */
@ApplicationScoped
public class Livewire {

    private static final Logger LOG = Logger.getLogger(Livewire.class);

    @Inject
    Vertx vertx;

    @Inject
    ObjectMapper json;

    // A wildcard, not the raw type: CDI matches a raw required type only to beans whose type
    // arguments are all Object, so Instance<Source> would find no Source<MyQuery> at all.
    @Inject
    @Any
    Instance<Source<?>> sources;

    @Inject
    @Any
    Instance<SourceWithContext<?>> contextualSources;

    @Inject
    @Any
    Instance<LiveCommands> commandBeans;

    @Inject
    Instance<LivewireAuthorizer> authorizer;

    @ConfigProperty(name = "livewire.path", defaultValue = "/livewire")
    String path;

    @ConfigProperty(name = "livewire.coalesce", defaultValue = "300ms")
    Duration coalesce;

    @SuppressWarnings("rawtypes")
    private final Map<String, Source> topics = new HashMap<>();
    private final Map<String, Command> commands = new HashMap<>();
    private final Set<Connection> connections = ConcurrentHashMap.newKeySet();
    private Registry registry;
    private Frames frames;

    /** A command, ready to run: the bean's proxy and the method to call on it. */
    record Command(Object bean, Method method, Class<?> payloadType) {
    }

    void routes(@Observes Router router) {
        frames = new Frames(json);
        registry = new Registry(vertx, coalesce);
        discover();
        router.route(path).handler(this::upgrade);
        LOG.infof("livewire: %d topic(s) %s and %d command(s) %s at %s", topics.size(), topics.keySet(),
                commands.size(), commands.keySet(), path);
    }

    /**
     * Tells every open connection that something happened — SPEC §6.2. An event, not a window:
     * nothing is applied to a list, and a client that does not know the topic ignores it.
     */
    public void notify(String topic, Object payload) {
        String frame = frames.envelope(Frames.NOTIFY, frames.notifyOf(topic, payload));
        for (Connection connection : connections) {
            connection.send(frame);
        }
    }

    private void upgrade(RoutingContext context) {
        LivewireAuthorizer gate = authorizer.isResolvable() ? authorizer.get() : null;
        boolean allowed = gate == null || gate.authorize(context);
        String refusal = allowed ? null : gate.refusal(context);
        context.request().toWebSocket().onSuccess(socket -> {
            if (!allowed) {
                LOG.warnf("livewire: socket refused: %s", refusal);
                // The frame first, then the close — SPEC §1. A proxy that drops the close code
                // would otherwise leave the client with nothing to explain itself.
                socket.writeTextMessage(frames.envelope(Frames.UPDATE, frames.errorOf("connection", refusal)));
                socket.close(Frames.NOT_AUTHORISED, "Not authorised");
                return;
            }
            Connection connection = new Connection(this, socket, vertx.getOrCreateContext(), context);
            connections.add(connection);
            socket.closeHandler(closed -> {
                connections.remove(connection);
                connection.closeAll();
            });
        }).onFailure(failure -> {
            // Not an upgrade at all: a plain GET on the socket's path.
            if (!context.response().ended()) {
                context.response().setStatusCode(400).end("A WebSocket upgrade is expected here");
            }
        });
    }

    @SuppressWarnings("rawtypes")
    Source source(String topic) {
        return topics.get(topic);
    }

    Command command(String name) {
        return commands.get(name);
    }

    Registry registry() {
        return registry;
    }

    Frames frames() {
        return frames;
    }

    Vertx vertx() {
        return vertx;
    }

    ObjectMapper json() {
        return json;
    }

    /** Runs a command's method; its exception, unwrapped, is the reason the client is given. */
    Object run(Command command, JsonNode payload) throws Exception {
        Object[] arguments = new Object[0];
        if (command.payloadType() != null) {
            arguments = new Object[] { JsonNode.class.equals(command.payloadType()) ? payload
                    : payload == null || payload.isNull() ? null : json.treeToValue(payload, command.payloadType()) };
        }
        try {
            return command.method().invoke(command.bean(), arguments);
        } catch (InvocationTargetException thrown) {
            throw thrown.getCause() instanceof Exception cause ? cause : thrown;
        }
    }

    /** A source under the topic its class names; none twice. */
    @SuppressWarnings("rawtypes")
    private void topic(Class<?> type, Source source) {
        LiveTopic topic = type.getAnnotation(LiveTopic.class);
        if (topic == null) {
            return;
        }
        if (topics.put(topic.value(), source) != null) {
            throw new IllegalStateException("livewire: two sources answer topic '" + topic.value() + "'");
        }
    }

    @SuppressWarnings("rawtypes")
    private void discover() {
        for (Instance.Handle<Source<?>> handle : sources.handles()) {
            topic(handle.getBean().getBeanClass(), handle.get());
        }
        for (Instance.Handle<SourceWithContext<?>> handle : contextualSources.handles()) {
            topic(handle.getBean().getBeanClass(), new Contextual<>(handle.get()));
        }
        for (Instance.Handle<LiveCommands> handle : commandBeans.handles()) {
            Object bean = handle.get();
            for (Method method : handle.getBean().getBeanClass().getMethods()) {
                LiveCommand named = method.getAnnotation(LiveCommand.class);
                if (named == null) {
                    continue;
                }
                if (Modifier.isStatic(method.getModifiers()) || method.getParameterCount() > 1) {
                    throw new IllegalStateException("livewire: command '" + named.value() + "' ("
                            + method + ") takes nothing or one payload, and is not static");
                }
                Class<?> payloadType = method.getParameterCount() == 1 ? method.getParameterTypes()[0] : null;
                if (commands.put(named.value(), new Command(bean, method, payloadType)) != null) {
                    throw new IllegalStateException("livewire: two methods answer command '" + named.value() + "'");
                }
            }
        }
    }
}
