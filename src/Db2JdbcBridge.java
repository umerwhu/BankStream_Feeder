import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** A private line-oriented JDBC adapter for the Node.js ODBC-shaped Db2 interface. */
public final class Db2JdbcBridge {
  private static final Base64.Decoder DECODER = Base64.getUrlDecoder();
  private static final Base64.Encoder ENCODER = Base64.getUrlEncoder().withoutPadding();
  private Connection connection;

  public static void main(String[] args) throws Exception {
    Db2JdbcBridge bridge = new Db2JdbcBridge();
    try (BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
         PrintWriter output = new PrintWriter(System.out, true, StandardCharsets.UTF_8)) {
      String line;
      while ((line = input.readLine()) != null) {
        String[] fields = line.split("\\t", -1);
        String id = fields.length == 0 ? "0" : fields[0];
        try {
          Object result = bridge.handle(fields);
          output.println(id + "\tOK\t" + encode(json(result)));
          if ("CLOSE".equals(fields.length > 1 ? fields[1] : "")) break;
        } catch (Throwable error) {
          String message = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
          output.println(id + "\tERR\t" + encode(message));
        }
      }
    } finally {
      if (bridge.connection != null) bridge.connection.close();
    }
  }

  private Object handle(String[] fields) throws Exception {
    String action = fields[1];
    switch (action) {
      case "CONNECT":
        connection = DriverManager.getConnection(decode(fields[2]), decode(fields[3]), decode(fields[4]));
        return Map.of("connected", true);
      case "QUERY":
        return query(decode(fields[2]), fields);
      case "BEGIN":
        connection.setAutoCommit(false);
        return Map.of("ok", true);
      case "COMMIT":
        connection.commit();
        connection.setAutoCommit(true);
        return Map.of("ok", true);
      case "ROLLBACK":
        connection.rollback();
        connection.setAutoCommit(true);
        return Map.of("ok", true);
      case "CLOSE":
        if (connection != null) { connection.close(); connection = null; }
        return Map.of("closed", true);
      default:
        throw new IllegalArgumentException("Unknown bridge action");
    }
  }

  private Object query(String sql, String[] fields) throws Exception {
    int parameterCount = Integer.parseInt(fields[3]);
    try (PreparedStatement statement = connection.prepareStatement(sql)) {
      for (int index = 0; index < parameterCount; index++) bind(statement, index + 1, fields[index + 4]);
      boolean hasRows = statement.execute();
      if (!hasRows) return Map.of("count", statement.getUpdateCount());
      try (ResultSet resultSet = statement.getResultSet()) {
        ResultSetMetaData metadata = resultSet.getMetaData();
        List<Map<String, Object>> rows = new ArrayList<>();
        while (resultSet.next()) {
          Map<String, Object> row = new LinkedHashMap<>();
          for (int column = 1; column <= metadata.getColumnCount(); column++) {
            row.put(metadata.getColumnLabel(column), value(resultSet.getObject(column)));
          }
          rows.add(row);
        }
        return rows;
      }
    }
  }

  private static void bind(PreparedStatement statement, int index, String field) throws Exception {
    char type = field.charAt(0);
    String value = decode(field.substring(1));
    switch (type) {
      case 'N': statement.setNull(index, java.sql.Types.NULL); break;
      case 'I': statement.setLong(index, Long.parseLong(value)); break;
      case 'F': statement.setDouble(index, Double.parseDouble(value)); break;
      case 'T': statement.setTimestamp(index, Timestamp.from(Instant.parse(value))); break;
      default: statement.setString(index, value);
    }
  }

  private static Object value(Object value) {
    if (value instanceof Timestamp) return ((Timestamp) value).toLocalDateTime().toString();
    if (value instanceof java.sql.Date) return value.toString();
    if (value instanceof java.math.BigDecimal) return ((java.math.BigDecimal) value).toPlainString();
    if (value instanceof Number || value instanceof Boolean || value instanceof String || value == null) return value;
    return value.toString();
  }

  private static String decode(String value) {
    return new String(DECODER.decode(value), StandardCharsets.UTF_8);
  }

  private static String encode(String value) {
    return ENCODER.encodeToString(value.getBytes(StandardCharsets.UTF_8));
  }

  private static String json(Object value) {
    if (value == null) return "null";
    if (value instanceof String) return quote((String) value);
    if (value instanceof Number || value instanceof Boolean) return value.toString();
    if (value instanceof Map<?, ?>) {
      List<String> parts = new ArrayList<>();
      ((Map<?, ?>) value).forEach((key, entry) -> parts.add(quote(String.valueOf(key)) + ":" + json(entry)));
      return "{" + String.join(",", parts) + "}";
    }
    if (value instanceof Iterable<?>) {
      List<String> parts = new ArrayList<>();
      for (Object entry : (Iterable<?>) value) parts.add(json(entry));
      return "[" + String.join(",", parts) + "]";
    }
    return quote(value.toString());
  }

  private static String quote(String value) {
    StringBuilder result = new StringBuilder("\"");
    for (char character : value.toCharArray()) {
      switch (character) {
        case '"': result.append("\\\""); break;
        case '\\': result.append("\\\\"); break;
        case '\n': result.append("\\n"); break;
        case '\r': result.append("\\r"); break;
        case '\t': result.append("\\t"); break;
        default:
          if (character < 0x20) result.append(String.format("\\u%04x", (int) character));
          else result.append(character);
      }
    }
    return result.append('"').toString();
  }
}
